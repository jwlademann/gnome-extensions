import St from 'gi://St';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';

const OSK_KEY = 'screen-keyboard-enabled';

export default class KeyboardToggleExtension extends Extension {
    enable() {
        this._timers = new Set();
        this._offPending = false;
        this._a11y = new Gio.Settings({
            schema_id: 'org.gnome.desktop.a11y.applications',
        });
        // Known starting state: OSK off until the button is pressed
        this._setOsk(false);

        this._button = new St.Button({
            style_class: 'panel-button',
            reactive: true,
            can_focus: true,
            track_hover: true,
            child: new St.Icon({
                icon_name: 'input-keyboard-symbolic',
                style_class: 'system-status-icon',
            }),
        });
        this._button.connect('clicked', () => this._toggle());

        // When the keyboard hides (OSK arrow button, focus loss, or our
        // button), switch the OSK feature off after the hide has settled.
        const box = Main.layoutManager.keyboardBox;
        this._visId = box.connect('notify::visible', () => {
            if (box.visible || this._offPending)
                return;
            this._offPending = true;
            this._after(100, () => {
                this._offPending = false;
                if (!box.visible)
                    this._setOsk(false);
            });
        });

        Main.panel._rightBox.insert_child_at_index(this._button, 0);
    }

    // The setting, not keyboardBox.visible, is the source of truth:
    // the box can report visible on a fresh login with no keyboard showing.
    _toggle() {
        if (this._a11y.get_boolean(OSK_KEY)) {
            Main.keyboard.close(false);
            // Fallback in case the box never changes visibility
            this._after(400, () => this._setOsk(false));
            return;
        }

        this._setOsk(true);
        this._after(40, () =>
            Main.keyboard.open(global.display.get_primary_monitor()));
    }

    _setOsk(value) {
        this._a11y?.set_boolean(OSK_KEY, value);
    }

    _after(ms, fn) {
        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            this._timers.delete(id);
            fn();
            return GLib.SOURCE_REMOVE;
        });
        this._timers.add(id);
    }

    disable() {
        for (const id of this._timers)
            GLib.source_remove(id);
        this._timers = null;

        if (this._visId) {
            Main.layoutManager.keyboardBox.disconnect(this._visId);
            this._visId = null;
        }

        this._setOsk(false);
        this._a11y = null;

        this._button?.destroy();
        this._button = null;
    }
}
