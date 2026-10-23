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

// ---------------------------------------------------------------- settings

const SAFE_BEFORE_SUSPEND = true;       // 60 Hz fixed + HDR off before suspending
const SAFE_INCLUDE_BUILTIN = false;     // also apply that to the laptop panel
const RESTORE_LAYOUT_AT_LOGIN = true;   // re-apply the last chosen layout at login

// Timings, in milliseconds
const SAFE_TIMEOUT_MS = 3500;       // logind only waits about 5 s before suspending anyway
const RESTORE_DELAY_MS = 2000;      // quiet time after a display change before restoring
const RESUME_DELAY_MS = 4000;       // longer, so the monitor can settle after a resume
const RESUME_SETTLE_MS = 10000;     // how long after a resume the longer delay applies
const STARTUP_HOLD_MS = 20000;
const RESUME_HOLD_MS = 30000;
const LID_HOLD_MS = 15000;
const HOTPLUG_HOLD_MS = 8000;
const LID_READ_TIMEOUT_MS = 2000;
const MAX_RESTORE_ATTEMPTS = 3;

// ----------------------------------------------------------------- helpers

const BUS = 'org.gnome.Mutter.DisplayConfig';
const PATH = '/org/gnome/Mutter/DisplayConfig';
const STORE = GLib.build_filenamev([GLib.get_user_config_dir(), 'display-switcher.json']);
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

function loadStore() {
    try {
        const [ok, bytes] = GLib.file_get_contents(STORE);
        return ok ? JSON.parse(new TextDecoder().decode(bytes)) : null;
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

// Method 1 = temporary: nothing is written to monitors.xml and no confirmation dialog
function applyConfig(serial, lms, props) {
    return dbus('ApplyMonitorsConfig', new GLib.Variant(
        '(uua(iiduba(ssa{sv}))a{sv})', [serial, 1, lms, props]));
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

function monitorsFor(state, type) {
    if (type === 'builtin')
        return state.mons.filter(m => m.builtin);
    if (type === 'external')
        return state.mons.filter(m => !m.builtin);
    return state.mons;
}

function layoutProps(state) {
    return state.props['supports-changing-layout-mode']
        ? {'layout-mode': new GLib.Variant('u', state.props['layout-mode'] ?? 1)}
        : {};
}

// Per-monitor properties for ApplyMonitorsConfig. The color mode must always be
// stated: leaving it out would reset it to default (HDR off).
function monitorProps(mon, colorMode, underscan) {
    const p = {};
    const supported = mon.p['supported-color-modes'] ?? [];
    if (colorMode !== undefined && supported.includes(colorMode))
        p['color-mode'] = new GLib.Variant('u', colorMode);
    if ('is-underscanning' in mon.p)
        p['underscanning'] = new GLib.Variant('b', underscan ?? mon.p['is-underscanning']);
    return p;
}

// ---------------------------------------------------------------- indicator

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
            (_lm, sleeping) => (sleeping ? this._suspending() : this._resumed()));
        this._takeInhibitor();

        this._lidId = 0;
        try {
            this._lidId = global.backend.connect('lid-is-closed-changed',
                (_b, closed) => this._lidChanged(closed));
        } catch (e) {
            console.error('display-switcher: no lid signal', e);
        }

        this.connect('destroy', () => this._onDestroy());

        // The hold must be in place before the first refresh, or the display state
        // Mutter chose at login would be learned as yours
        if (this._saved.size > 0)
            this._hold(STARTUP_HOLD_MS, 'startup');
        this._start();
    }

    _onDestroy() {
        this._destroyed = true;
        this._mm.disconnect(this._mmId);
        this._loginManager.disconnect(this._sleepId);
        this._releaseInhibitor();
        if (this._lidId)
            global.backend.disconnect(this._lidId);
        this._cancelRestore();
    }

    async _start() {
        this._lidClosed = await this._readLid();   // so a shut lid isn't fought with
        if (this._destroyed)
            return;
        if (this._lidClosed)
            log('lid is closed at startup');

        // Trust saved memory over whatever state we happen to start in
        if (this._saved.size > 0) {
            if (RESTORE_LAYOUT_AT_LOGIN)
                this._modeUntil = nowMs() + STARTUP_HOLD_MS;
            this._scheduleRestore();
        }
        await this._refresh();

        if (this._mode === null)
            await this._seedMode();
    }

    // Mutter reads the lid state from UPower, and there is no getter on Meta.Backend
    async _readLid() {
        try {
            const reply = await Gio.DBus.system.call(
                'org.freedesktop.UPower', '/org/freedesktop/UPower',
                'org.freedesktop.DBus.Properties', 'Get',
                new GLib.Variant('(ss)', ['org.freedesktop.UPower', 'LidIsClosed']),
                null, Gio.DBusCallFlags.NONE, LID_READ_TIMEOUT_MS, null);
            return !!reply.recursiveUnpack()[0];
        } catch (e) {
            console.error('display-switcher: could not read lid state', e);
            return false;
        }
    }

    // Older store files have no layout; learn it from the current state
    async _seedMode() {
        try {
            if (this._learnMode(await getState()))
                this._persist();
        } catch (_e) {
            // the next refresh will try again
        }
    }

    // ------------------------------------------------- suspend, resume, lid

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

    async _suspending() {
        // Store what's on screen, unless an automatic change is already underway
        const held = nowMs() < this._holdUntil;
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
    }

    _resumed() {
        const now = nowMs();
        this._attempts = 0;
        this._resumedAt = now;
        this._hold(RESUME_HOLD_MS, 'resumed', true);
        this._modeUntil = now + RESUME_HOLD_MS;
        this._scheduleRestore(RESUME_DELAY_MS);
        this._takeInhibitor();
    }

    _lidChanged(closed) {
        this._lidClosed = closed;
        this._attempts = 0;
        this._hold(LID_HOLD_MS, closed ? 'lid closed' : 'lid opened');
        this._modeUntil = Math.max(this._modeUntil, nowMs() + LID_HOLD_MS);
        this._scheduleRestore();
    }

    // Same layout as now, but 60 Hz fixed and HDR off on the targeted monitors
    _safeConfig(state) {
        let changed = false;

        const lms = state.lms.map(lm => [
            lm.x, lm.y, lm.scale, lm.transform, lm.primary,
            lm.conns.map(c => {
                const mon = state.mons.find(m => m.connector === c);
                const cur = mon.current;
                const supported = mon.p['supported-color-modes'] ?? [];
                let modeId = cur[0];
                let colorMode = mon.p['color-mode'];

                if (!mon.builtin || SAFE_INCLUDE_BUILTIN) {
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
                return [c, modeId, monitorProps(mon, colorMode)];
            }),
        ]);

        return changed ? {lms, props: layoutProps(state)} : null;
    }

    async _enterSafeMode() {
        const state = await getState();
        const cfg = this._safeConfig(state);
        if (!cfg) {
            log('nothing to lower before suspend');
            return;
        }
        log('lowering to 60 Hz fixed with HDR off for suspend');
        await applyConfig(state.serial, cfg.lms, cfg.props);
    }

    // ------------------------------------------------------------ learning

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
            if (this._destroyed)
                return;
            const now = nowMs();
            const conns = state.mons.map(m => m.connector).sort().join(',');
            if (this._conns !== null && conns !== this._conns) {
                this._attempts = 0;
                this._hold(HOTPLUG_HOLD_MS, `monitors ${this._conns} -> ${conns}`);
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
        let changed = !onlyNew && this._learnMode(state);
        if (!state.lms.some(l => l.conns.length > 1))
            changed = this._learnMonitors(state, onlyNew) || changed;
        if (changed)
            this._persist();
    }

    // Which displays are on. Not learned with the lid shut: the panel is forced off then.
    _learnMode(state) {
        if (this._lidClosed || !state.mons.some(m => m.builtin))
            return false;
        const mode = currentMode(state);
        if (!mode || mode === this._mode)
            return false;
        log(`layout is now ${mode}`);
        this._mode = mode;
        return true;
    }

    // With onlyNew, only monitors we have never seen are added
    _learnMonitors(state, onlyNew) {
        let changed = false;
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
                changed = changed || this._primary !== conn;
                this._primary = conn;
            }
        }

        if (layout.size > 1 && !onlyNew) {
            const before = this._layout ? JSON.stringify([...this._layout]) : null;
            changed = changed || JSON.stringify([...layout]) !== before;
            this._layout = layout;
        }
        return changed;
    }

    // ----------------------------------------------------------- restoring

    _cancelRestore() {
        if (this._restoreTimer) {
            GLib.source_remove(this._restoreTimer);
            this._restoreTimer = 0;
        }
    }

    _scheduleRestore(delay = null) {
        this._cancelRestore();
        const settling = nowMs() - this._resumedAt < RESUME_SETTLE_MS;
        const ms = delay ?? (settling ? RESUME_DELAY_MS : RESTORE_DELAY_MS);
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
        if (this._attempts >= MAX_RESTORE_ATTEMPTS) {
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
        switch (m) {
        case 'mirror':
        case 'join':
            return state.mons.length > 1 ? m : null;
        case 'external':
            return state.mons.some(x => !x.builtin) ? m : null;
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

        const mirrored = cur === 'mirror';
        for (const lm of state.lms) {
            for (const c of lm.conns) {
                const why = this._drift(state, lm, c, mirrored);
                if (why)
                    return {why, type: cur ?? 'join'};
            }
        }
        return null;
    }

    // How a monitor differs from what we remembered, or null if it doesn't
    _drift(state, lm, c, mirrored) {
        const mon = state.mons.find(m => m.connector === c);
        const saved = this._saved.get(c);
        if (!mon || !saved)
            return null;

        const supported = mon.p['supported-color-modes'] ?? [];
        if (saved.colorMode !== undefined &&
            supported.includes(saved.colorMode) &&
            mon.p['color-mode'] !== saved.colorMode)
            return `${c} color-mode ${mon.p['color-mode']} -> ${saved.colorMode}`;
        if (mirrored)
            return null;

        const hasMode = mon.modes.some(md => md[0] === saved.modeId);
        if (hasMode && mon.current?.[0] !== saved.modeId)
            return `${c} mode ${mon.current?.[0]} -> ${saved.modeId}`;
        if (!close(lm.scale, saved.scale))
            return `${c} scale ${lm.scale} -> ${saved.scale}`;
        return null;
    }

    // ---------------------------------------------------------------- menu

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
            this._cancelRestore();
            if (learn)
                this._snapshot(state);
            await this._apply(state, type);
        } catch (e) {
            console.error('display-switcher: switch failed', e);
        }
    }

    // ------------------------------------------------------ building configs

    async _apply(state, type) {
        // Try the remembered arrangement first, then plain left-to-right
        const tries = this._layout && type !== 'mirror' ? [true, false] : [false];
        let lastErr = null;
        for (const useLayout of tries) {
            const cfg = this._config(state, type, useLayout);
            if (!cfg)
                return;
            try {
                await applyConfig(state.serial, cfg.lms, cfg.props);
                return;
            } catch (e) {
                lastErr = e;
            }
        }
        throw lastErr;
    }

    _transformOf(state, c) {
        return this._saved.get(c)?.transform ??
            state.lms.find(l => l.conns.includes(c))?.transform ?? 0;
    }

    // The ApplyMonitorsConfig arguments for a preset, built from remembered settings
    _config(state, type, useLayout) {
        const layoutMode = state.props['layout-mode'] ?? 1;
        const mirror = type === 'mirror';
        const set = monitorsFor(state, type);
        if (!set.length)
            return null;

        const picks = mirror ? this._pickMirror(set) : this._pickEach(state, set);
        if (!picks)
            return null;

        // One logical monitor per unit (all monitors together when mirroring)
        const units = mirror ? [set] : set.map(m => [m]);
        const dims = units.map(u => {
            const c = u[0].connector;
            const {mode, scale} = picks.get(c);
            let w = mode[1], h = mode[2];
            if (this._transformOf(state, c) % 2 === 1)
                [w, h] = [h, w];
            if (layoutMode === 1) {   // logical layout divides by scale; physical does not
                w = Math.round(w / scale);
                h = Math.round(h / scale);
            }
            return [w, h];
        });

        const pos = this._positions(set, units, dims, useLayout);
        const minX = Math.min(...pos.map(p => p[0]));
        const minY = Math.min(...pos.map(p => p[1]));

        const primary = set.some(m => m.connector === this._primary)
            ? this._primary
            : (set.find(m => m.builtin) ?? set[0]).connector;

        const lms = units.map((u, i) => {
            const c = u[0].connector;
            return [
                pos[i][0] - minX, pos[i][1] - minY,
                picks.get(c).scale,
                this._transformOf(state, c),
                mirror || u.some(m => m.connector === primary),
                u.map(m => {
                    const saved = this._saved.get(m.connector);
                    return [m.connector, picks.get(m.connector).mode[0],
                        monitorProps(m, saved?.colorMode ?? m.p['color-mode'], saved?.underscan)];
                }),
            ];
        });
        return {lms, props: layoutProps(state)};
    }

    // Mirroring: the largest resolution every monitor offers, one shared scale
    _pickMirror(set) {
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

        const picks = new Map();
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
        return picks;
    }

    // Everything else: each monitor gets its remembered mode and scale
    _pickEach(state, set) {
        const scaleNow = new Map(state.lms.flatMap(l => l.conns.map(c => [c, l.scale])));
        const picks = new Map();
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
        return picks;
    }

    // Where each unit goes: the remembered arrangement if it fits, else left to right
    _positions(set, units, dims, useLayout) {
        if (units.length === 1)
            return [[0, 0]];
        if (useLayout && this._layout && this._layout.size === set.length &&
            set.every(m => this._layout.has(m.connector)))
            return units.map(u => this._layout.get(u[0].connector));

        const xOf = u => this._layout?.get(u[0].connector)?.[0] ?? Infinity;
        const order = units.map((_u, i) => i).sort((a, b) =>
            (xOf(units[a]) - xOf(units[b])) ||
            (units[b][0].builtin - units[a][0].builtin));
        const pos = [];
        let x = 0;
        for (const i of order) {
            pos[i] = [x, 0];
            x += dims[i][0];
        }
        return pos;
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
