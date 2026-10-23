import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as Util from 'resource:///org/gnome/shell/misc/util.js';
import {getLoginManager} from 'resource:///org/gnome/shell/misc/loginManager.js';

Gio._promisify(Gio.DBusConnection.prototype, 'call', 'call_finish');

const BUS = 'org.gnome.Mutter.DisplayConfig';
const PATH = '/org/gnome/Mutter/DisplayConfig';
const EPS = 0.001;
const close = (a, b) => Math.abs(a - b) < EPS;
const isVrr = md => md[6]['refresh-rate-mode'] === 'variable';
const log = msg => console.log(`display-switcher: ${msg}`);
const nowMs = () => GLib.get_monotonic_time() / 1000;
const pause = ms => new Promise(res =>
    GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
        res();
        return GLib.SOURCE_REMOVE;
    }));

// Suspend/resume behaviour
const SAFE_BEFORE_SUSPEND = true;    // 60 Hz fixed + HDR off before suspending
const SAFE_INCLUDE_BUILTIN = false;  // also apply that to the laptop panel
const SAFE_TIMEOUT_MS = 3500;        // logind only waits about 5 s before suspending anyway
const RESUME_DELAY_MS = 4000;        // let the monitor settle before restoring after resume

const STORE = GLib.build_filenamev([GLib.get_user_config_dir(), 'display-switcher.json']);

function loadStore() {
    try {
        const [ok, bytes] = GLib.file_get_contents(STORE);
        if (!ok)
            return null;
        return JSON.parse(new TextDecoder().decode(bytes));
    } catch (_e) {
        return null;
    }
}

function saveStore(data) {
    try {
        GLib.file_set_contents(STORE, JSON.stringify(data));
    } catch (e) {
        console.error('display-switcher: could not save settings', e);
    }
}

function dbus(method, params) {
    return Gio.DBus.session.call(BUS, PATH, BUS, method, params, null,
        Gio.DBusCallFlags.NONE, -1, null);
}

async function getState() {
    const reply = await dbus('GetCurrentState', null);
    const [serial, monitors, logical, props] = reply.recursiveUnpack();
    const mons = monitors.map(([spec, modes, p]) => ({
        connector: spec[0],
        modes,
        p,
        builtin: !!p['is-builtin'],
        current: modes.find(m => m[6]['is-current']),
        preferred: modes.find(m => m[6]['is-preferred']),
    }));
    const lms = logical.map(([x, y, scale, transform, primary, ms]) => ({
        x, y, scale, transform, primary, conns: ms.map(s => s[0]),
    }));
    return {serial, mons, lms, props};
}

// Work out which preset is active from the real state, not from Mutter's bookkeeping.
function currentMode(state) {
    if (state.lms.some(l => l.conns.length > 1))
        return 'mirror';
    if (state.mons.some(m => m.builtin)) {
        const active = new Set(state.lms.flatMap(l => l.conns));
        const act = state.mons.filter(m => active.has(m.connector));
        if (act.length && act.every(m => m.builtin))
            return 'builtin';
        if (act.length && act.every(m => !m.builtin))
            return 'external';
    }
    return state.lms.length > 1 ? 'join' : null;
}

const Indicator = GObject.registerClass(
class Indicator extends PanelMenu.Button {
    _init() {
        super._init(0.0, 'Display Switcher');

        // Everything remembered survives the extension being re-enabled or a logout
        const stored = loadStore();
        this._saved = new Map(Object.entries(stored?.saved ?? {}));
        this._layout = stored?.layout ? new Map(Object.entries(stored.layout)) : null;
        this._primary = stored?.primary ?? null;
        this._mode = stored?.mode ?? null;   // which displays are on: mirror/join/external/builtin

        this._conns = null;         // connector set at the last refresh
        this._holdUntil = 0;        // ms: changes before this are automatic, not yours
        this._modeUntil = 0;        // ms: until then the remembered layout is enforced
        this._resumedAt = -Infinity;
        this._lidClosed = false;
        this._restoreTimer = 0;
        this._attempts = 0;
        this._destroyed = false;
        this._inhibitor = null;
        this._inhibiting = false;

        this.add_child(new St.Icon({
            icon_name: 'video-display-symbolic',
            style_class: 'system-status-icon',
        }));

        this._mm = global.backend.get_monitor_manager();
        this._mmId = this._mm.connect('monitors-changed', () => this._refresh());

        // Hold a suspend delay lock so we can tidy up displays before the machine sleeps
        this._loginManager = getLoginManager();
        this._sleepId = this._loginManager.connect('prepare-for-sleep',
            (_lm, sleeping) => this._onSleep(sleeping));
        this._takeInhibitor();

        this._lidId = 0;
        try {
            this._lidId = global.backend.connect('lid-is-closed-changed', (_b, closed) => {
                this._lidClosed = closed;
                this._attempts = 0;
                this._hold(15000, closed ? 'lid closed' : 'lid opened');
                this._modeUntil = Math.max(this._modeUntil, nowMs() + 15000);
                this._scheduleRestore();
            });
        } catch (e) {
            console.error('display-switcher: no lid signal', e);
        }

        this.connect('destroy', () => {
            this._destroyed = true;
            this._mm.disconnect(this._mmId);
            this._loginManager.disconnect(this._sleepId);
            this._releaseInhibitor();
            if (this._lidId)
                global.backend.disconnect(this._lidId);
            if (this._restoreTimer)
                GLib.source_remove(this._restoreTimer);
        });

        // Trust saved memory over whatever state we happen to start in
        if (this._saved.size > 0) {
            this._hold(20000, 'startup');
            this._scheduleRestore();
        }
        if (this._mode === null) {
            getState().then(s => {
                if (this._mode === null && s.mons.some(m => m.builtin)) {
                    this._mode = currentMode(s);
                    log(`layout is now ${this._mode}`);
                    this._persist();
                }
            }).catch(() => {});
        }
        this._refresh();
    }

    async _takeInhibitor() {
        if (this._inhibitor || this._inhibiting)
            return;
        this._inhibiting = true;
        try {
            const stream = await this._loginManager.inhibit(
                'Lowering display settings before suspend', null);
            if (this._destroyed)
                stream?.close(null);
            else
                this._inhibitor = stream;
        } catch (e) {
            console.error('display-switcher: could not take suspend lock', e);
        } finally {
            this._inhibiting = false;
        }
    }

    _releaseInhibitor() {
        try {
            this._inhibitor?.close(null);
        } catch (e) {
            console.error('display-switcher: could not release suspend lock', e);
        }
        this._inhibitor = null;
    }

    async _onSleep(sleeping) {
        const now = nowMs();
        if (sleeping) {
            // Store what's on screen, unless an automatic change is already underway
            const held = now < this._holdUntil;
            this._hold(Infinity, 'suspending');
            try {
                if (!held)
                    await this._snapshotNow('before suspend');
                if (SAFE_BEFORE_SUSPEND)
                    await Promise.race([this._enterSafeMode(), pause(SAFE_TIMEOUT_MS)]);
            } catch (e) {
                console.error('display-switcher: pre-suspend step failed', e);
            } finally {
                this._releaseInhibitor();   // let the machine go to sleep
            }
        } else {
            this._attempts = 0;
            this._resumedAt = now;
            this._hold(30000, 'resumed', true);
            this._modeUntil = now + 30000;
            this._scheduleRestore(RESUME_DELAY_MS);
            this._takeInhibitor();
        }
    }

    // Same layout as now, but 60 Hz fixed and HDR off on the targeted monitors
    _safeConfig(state) {
        const layoutMode = state.props['layout-mode'] ?? 1;
        let changed = false;

        const lms = state.lms.map(lm => [
            lm.x, lm.y, lm.scale, lm.transform, lm.primary,
            lm.conns.map(c => {
                const mon = state.mons.find(m => m.connector === c);
                const cur = mon.current;
                const supported = mon.p['supported-color-modes'] ?? [];
                const target = !mon.builtin || SAFE_INCLUDE_BUILTIN;
                let modeId = cur[0];
                let colorMode = mon.p['color-mode'];
                const p = {};

                if (target) {
                    const safe = mon.modes
                        .filter(md => md[1] === cur[1] && md[2] === cur[2] &&
                            !isVrr(md) && !md[6]['is-interlaced'] &&
                            Math.abs(md[3] - 60) < 1 &&
                            md[5].some(s => close(s, lm.scale)))
                        .sort((a, b) => Math.abs(a[3] - 60) - Math.abs(b[3] - 60))[0];
                    if (safe && safe[0] !== modeId) {
                        modeId = safe[0];
                        changed = true;
                    }
                    if (colorMode !== undefined && colorMode !== 0 && supported.includes(0)) {
                        colorMode = 0;
                        changed = true;
                    }
                }
                // Always state the color mode: leaving it out would reset it to default
                if (colorMode !== undefined && supported.includes(colorMode))
                    p['color-mode'] = new GLib.Variant('u', colorMode);
                if ('is-underscanning' in mon.p)
                    p['underscanning'] = new GLib.Variant('b', mon.p['is-underscanning']);
                return [c, modeId, p];
            }),
        ]);

        if (!changed)
            return null;
        const props = state.props['supports-changing-layout-mode']
            ? {'layout-mode': new GLib.Variant('u', layoutMode)}
            : {};
        return {serial: state.serial, lms, props};
    }

    async _enterSafeMode() {
        const state = await getState();
        const cfg = this._safeConfig(state);
        if (!cfg) {
            log('nothing to lower before suspend');
            return;
        }
        log('lowering to 60 Hz fixed with HDR off for suspend');
        await dbus('ApplyMonitorsConfig', new GLib.Variant(
            '(uua(iiduba(ssa{sv}))a{sv})',
            [cfg.serial, 1, cfg.lms, cfg.props]));
    }

    _hold(ms, why, replace = false) {
        const until = ms === Infinity ? Infinity : nowMs() + ms;
        if (replace || until > this._holdUntil)
            this._holdUntil = until;
        log(`ignoring automatic changes (${why})`);
    }

    _persist() {
        saveStore({
            saved: Object.fromEntries(this._saved),
            layout: this._layout ? Object.fromEntries(this._layout) : null,
            primary: this._primary,
            mode: this._mode,
        });
    }

    async _snapshotNow(why) {
        try {
            const state = await getState();
            log(`storing display settings (${why})`);
            this._snapshot(state);
        } catch (e) {
            console.error('display-switcher: snapshot failed', e);
        }
    }

    async _refresh() {
        try {
            const state = await getState();
            const now = nowMs();
            const conns = state.mons.map(m => m.connector).sort().join(',');
            if (this._conns !== null && conns !== this._conns) {
                this._attempts = 0;
                this._hold(8000, `monitors ${this._conns} -> ${conns}`);
            }
            this._conns = conns;

            if (this._saved.size === 0) {
                this._snapshot(state);             // first ever run: seed from current state
            } else if (now < this._holdUntil) {
                this._scheduleRestore();           // automatic change: don't learn from it
            } else {
                this._snapshot(state);
                this._attempts = 0;
            }
            this._rebuild(state);
        } catch (e) {
            console.error('display-switcher: refresh failed', e);
        }
    }

    // Remember which displays are on, plus every active monitor's settings.
    // Per-monitor settings are skipped while mirrored, because a mirror's shared
    // resolution isn't the user's own choice for each monitor.
    _snapshot(state, onlyNew = false) {
        let changed = false;
        const mirrored = state.lms.some(l => l.conns.length > 1);

        if (!onlyNew && !this._lidClosed && state.mons.some(m => m.builtin)) {
            const mode = currentMode(state);
            if (mode && mode !== this._mode) {
                log(`layout is now ${mode}`);
                this._mode = mode;
                changed = true;
            }
        }
        if (mirrored) {
            if (changed)
                this._persist();
            return;
        }

        const layout = new Map();
        for (const lm of state.lms) {
            const conn = lm.conns[0];
            const mon = state.mons.find(m => m.connector === conn);
            if (!mon?.current)
                continue;
            layout.set(conn, [lm.x, lm.y]);
            if (onlyNew && this._saved.has(conn))
                continue;
            const entry = {
                modeId: mon.current[0],
                refresh: mon.current[3],
                vrr: isVrr(mon.current),
                scale: lm.scale,
                transform: lm.transform,
                colorMode: mon.p['color-mode'],
                underscan: mon.p['is-underscanning'],
            };
            const prev = this._saved.get(conn);
            if (!prev || JSON.stringify(prev) !== JSON.stringify(entry)) {
                log(`remembering ${conn}: ${entry.modeId} scale ${entry.scale} ` +
                    `color-mode ${entry.colorMode}`);
                changed = true;
            }
            this._saved.set(conn, entry);
            if (lm.primary && !onlyNew) {
                if (this._primary !== conn)
                    changed = true;
                this._primary = conn;
            }
        }
        if (layout.size > 1 && !onlyNew) {
            const before = this._layout ? JSON.stringify([...this._layout]) : null;
            if (JSON.stringify([...layout]) !== before)
                changed = true;
            this._layout = layout;
        }
        if (changed)
            this._persist();
    }

    _scheduleRestore(delay = null) {
        if (this._restoreTimer)
            GLib.source_remove(this._restoreTimer);
        // Shortly after a resume, wait longer so the monitor can settle first
        const ms = delay ?? (nowMs() - this._resumedAt < 10000 ? RESUME_DELAY_MS : 2000);
        this._restoreTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            this._restoreTimer = 0;
            this._restoreIfNeeded().catch(e =>
                console.error('display-switcher: restore failed', e));
            return GLib.SOURCE_REMOVE;
        });
    }

    async _restoreIfNeeded() {
        if (this._holdUntil === Infinity)
            return;                                // suspending
        const state = await getState();
        const need = this._needsRestore(state);
        if (!need) {
            this._attempts = 0;
            this._snapshot(state, true);           // learn only monitors we haven't seen
            return;
        }
        if (this._attempts >= 3) {
            log(`giving up restoring (${need.why})`);
            return;
        }
        this._attempts++;
        log(`restoring: ${need.why}`);
        await this._apply(state, need.type);
    }

    // The layout we want right now, or null if there's nothing sensible to enforce
    _targetMode(state) {
        let m = this._mode;
        if (!m || !state.mons.some(x => x.builtin))
            return null;
        if (this._lidClosed && m !== 'external')
            m = 'external';                        // built-in panel can't be on with the lid shut
        const hasExternal = state.mons.some(x => !x.builtin);
        switch (m) {
        case 'mirror':
        case 'join':
            return state.mons.length > 1 ? m : null;
        case 'external':
            return hasExternal ? m : null;
        case 'builtin':
            return m;
        default:
            return null;
        }
    }

    _needsRestore(state) {
        const cur = currentMode(state);

        if (nowMs() < this._modeUntil) {
            const target = this._targetMode(state);
            if (target && cur !== target)
                return {why: `layout ${cur} -> ${target}`, type: target};
        }

        const type = cur ?? 'join';
        const mirrored = cur === 'mirror';
        for (const lm of state.lms) {
            for (const c of lm.conns) {
                const mon = state.mons.find(m => m.connector === c);
                const saved = this._saved.get(c);
                if (!mon || !saved)
                    continue;
                const supported = mon.p['supported-color-modes'] ?? [];
                if (saved.colorMode !== undefined &&
                    supported.includes(saved.colorMode) &&
                    mon.p['color-mode'] !== saved.colorMode)
                    return {why: `${c} color-mode ${mon.p['color-mode']} -> ${saved.colorMode}`, type};
                if (mirrored)
                    continue;
                const hasMode = mon.modes.some(md => md[0] === saved.modeId);
                if (hasMode && mon.current?.[0] !== saved.modeId)
                    return {why: `${c} mode ${mon.current?.[0]} -> ${saved.modeId}`, type};
                if (!close(lm.scale, saved.scale))
                    return {why: `${c} scale ${lm.scale} -> ${saved.scale}`, type};
            }
        }
        return null;
    }

    _rebuild(state) {
        this.menu.removeAll();
        const modes = [
            ['mirror', 'Mirror', 'shell-display-mirror-symbolic'],
            ['join', 'Join Displays', 'shell-display-extend-all-symbolic'],
        ];
        if (state.mons.some(m => m.builtin)) {
            modes.push(
                ['external', 'External Only', 'shell-display-external-only-symbolic'],
                ['builtin', 'Built-in Only', 'shell-display-built-in-only-symbolic']);
        }
        const current = currentMode(state);
        for (const [type, label, icon] of modes) {
            const item = this.menu.addAction(label, () => this._switchTo(type), icon);
            if (type === current)
                item.setOrnament(PopupMenu.Ornament.DOT);
            item.setSensitive(state.mons.length > 1);
        }

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this.menu.addAction('Display Settings…',
            () => Util.spawn(['gnome-control-center', 'display']),
            'preferences-system-symbolic');
    }

    _config(state, type, useLayout) {
        const layoutMode = state.props['layout-mode'] ?? 1;
        const mirror = type === 'mirror';
        let set = state.mons;
        if (type === 'builtin')
            set = set.filter(m => m.builtin);
        else if (type === 'external')
            set = set.filter(m => !m.builtin);
        if (!set.length)
            return null;

        const scaleNow = new Map(state.lms.flatMap(l => l.conns.map(c => [c, l.scale])));
        const transformOf = c => this._saved.get(c)?.transform ??
            state.lms.find(l => l.conns.includes(c))?.transform ?? 0;
        const picks = new Map();   // connector -> {mode, scale}

        if (mirror) {
            // Largest resolution every monitor offers
            const res = m => new Set(m.modes.map(md => `${md[1]}x${md[2]}`));
            let common = [...res(set[0])];
            for (const m of set.slice(1)) {
                const r = res(m);
                common = common.filter(k => r.has(k));
            }
            if (!common.length)
                return null;
            const area = k => k.split('x').reduce((a, b) => a * b, 1);
            common.sort((a, b) => area(b) - area(a));
            const [w, h] = common[0].split('x').map(Number);

            for (const m of set) {
                const saved = this._saved.get(m.connector);
                const want = saved?.refresh ?? m.current?.[3] ?? 60;
                const wantVrr = saved?.vrr ?? false;
                const cands = m.modes.filter(md => md[1] === w && md[2] === h);
                cands.sort((a, b) => {
                    const d = Math.abs(a[3] - want) - Math.abs(b[3] - want);
                    if (Math.abs(d) > 0.01)
                        return d;
                    return (isVrr(a) === wantVrr ? 0 : 1) - (isVrr(b) === wantVrr ? 0 : 1);
                });
                picks.set(m.connector, {mode: cands[0]});
            }

            // One scale supported by every chosen mode
            let scales = [...picks.values()][0].mode[5];
            for (const {mode} of picks.values())
                scales = scales.filter(s => mode[5].some(t => close(s, t)));
            const first = this._saved.get(set[0].connector)?.scale;
            const scale = [first, 1.0]
                .map(c => scales.find(s => close(s, c)))
                .find(s => s !== undefined) ?? scales[0] ?? 1.0;
            for (const p of picks.values())
                p.scale = scale;
        } else {
            for (const m of set) {
                const saved = this._saved.get(m.connector);
                const mode = m.modes.find(md => md[0] === saved?.modeId) ??
                    m.current ?? m.preferred ?? m.modes[0];
                let scale = mode[4];
                for (const c of [saved?.scale, scaleNow.get(m.connector), mode[4]]) {
                    const s = mode[5].find(t => close(t, c));
                    if (s !== undefined) {
                        scale = s;
                        break;
                    }
                }
                picks.set(m.connector, {mode, scale});
            }
        }

        // One logical monitor per unit (all monitors together when mirroring)
        const units = mirror ? [set] : set.map(m => [m]);
        const dims = units.map(u => {
            const c = u[0].connector;
            const {mode, scale} = picks.get(c);
            let w = mode[1], h = mode[2];
            if (transformOf(c) % 2 === 1)
                [w, h] = [h, w];
            if (layoutMode === 1) {   // logical layout divides by scale; physical does not
                w = Math.round(w / scale);
                h = Math.round(h / scale);
            }
            return [w, h];
        });

        let pos;
        if (units.length === 1) {
            pos = [[0, 0]];
        } else if (useLayout && this._layout && this._layout.size === set.length &&
                   set.every(m => this._layout.has(m.connector))) {
            pos = units.map(u => this._layout.get(u[0].connector));
        } else {
            const xOf = u => this._layout?.get(u[0].connector)?.[0] ?? Infinity;
            const order = units.map((_u, i) => i).sort((a, b) =>
                (xOf(units[a]) - xOf(units[b])) ||
                (units[b][0].builtin - units[a][0].builtin));
            pos = [];
            let x = 0;
            for (const i of order) {
                pos[i] = [x, 0];
                x += dims[i][0];
            }
        }
        const minX = Math.min(...pos.map(p => p[0]));
        const minY = Math.min(...pos.map(p => p[1]));

        const primary = set.some(m => m.connector === this._primary)
            ? this._primary
            : (set.find(m => m.builtin) ?? set[0]).connector;

        const monProps = m => {
            const saved = this._saved.get(m.connector);
            const p = {};
            const supported = m.p['supported-color-modes'] ?? [];
            const cm = saved?.colorMode ?? m.p['color-mode'];
            if (cm !== undefined && supported.includes(cm))
                p['color-mode'] = new GLib.Variant('u', cm);
            if ('is-underscanning' in m.p) {
                p['underscanning'] = new GLib.Variant('b',
                    saved?.underscan ?? m.p['is-underscanning']);
            }
            return p;
        };

        const lms = units.map((u, i) => {
            const c = u[0].connector;
            return [
                pos[i][0] - minX, pos[i][1] - minY,
                picks.get(c).scale,
                transformOf(c),
                mirror || u.some(m => m.connector === primary),
                u.map(m => [m.connector, picks.get(m.connector).mode[0], monProps(m)]),
            ];
        });
        const props = state.props['supports-changing-layout-mode']
            ? {'layout-mode': new GLib.Variant('u', layoutMode)}
            : {};
        return {lms, props};
    }

    async _apply(state, type) {
        // Try the remembered arrangement first, then plain left-to-right
        const tries = this._layout && type !== 'mirror' ? [true, false] : [false];
        let lastErr = null;
        for (const useLayout of tries) {
            const cfg = this._config(state, type, useLayout);
            if (!cfg)
                return;
            try {
                await dbus('ApplyMonitorsConfig', new GLib.Variant(
                    '(uua(iiduba(ssa{sv}))a{sv})',
                    [state.serial, 1, cfg.lms, cfg.props]));
                return;
            } catch (e) {
                lastErr = e;
            }
        }
        throw lastErr;
    }

    async _switchTo(type) {
        try {
            const state = await getState();
            if (state.mons.length < 2)
                return;
            // Only learn the current state if it isn't an automatic reset
            const learn = nowMs() >= this._holdUntil;
            // A menu click is you deciding: cancel any pending restore or enforcement
            this._holdUntil = 0;
            this._modeUntil = 0;
            this._attempts = 0;
            if (this._restoreTimer) {
                GLib.source_remove(this._restoreTimer);
                this._restoreTimer = 0;
            }
            if (learn)
                this._snapshot(state);
            await this._apply(state, type);
        } catch (e) {
            console.error('display-switcher: switch failed', e);
        }
    }
});

export default class DisplaySwitcher extends Extension {
    enable() {
        this._indicator = new Indicator();
        Main.panel.addToStatusArea(this.uuid, this._indicator);
    }
    disable() {
        this._indicator?.destroy();
        this._indicator = null;
    }
}
