
import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';

import {Extension} from
    'resource:///org/gnome/shell/extensions/extension.js';
import * as KeyboardModule from
    'resource:///org/gnome/shell/ui/keyboard.js';
import * as Main from
    'resource:///org/gnome/shell/ui/main.js';
import * as QuickSettings from
    'resource:///org/gnome/shell/ui/quickSettings.js';

const TerminalOSKToggle = GObject.registerClass(
    class TerminalOSKToggle extends QuickSettings.QuickToggle {
        constructor() {
            super({
                title: 'Terminal OSK',
                iconName: 'input-keyboard-symbolic',
                toggleMode: true,
            });
        }
    }
);

export default class ForceTerminalOSK extends Extension {
    enable() {
        this._keyboardPrototype = KeyboardModule.Keyboard.prototype;
        this._originalUpdateKeys = this._keyboardPrototype._updateKeys;

        this._toggle = new TerminalOSKToggle();
        this._toggle.checked = true;

        this._toggle.connect('notify::checked', () => {
            this._setOverride(this._toggle.checked);
        });

        this._indicator = new QuickSettings.SystemIndicator();
        this._indicator.quickSettingsItems.push(this._toggle);

        Main.panel.statusArea.quickSettings.addExternalIndicator(
            this._indicator
        );

        this._setOverride(true);
    }

    _setOverride(enabled) {
        if (enabled) {
            this._keyboardPrototype._updateKeys = function () {
                const group =
                    this._keyboardController.getCurrentGroup();

                this._updateLayout(
                    group,
                    Clutter.InputContentPurpose.TERMINAL
                );

                this._setActiveLevel('default');
            };
        } else {
            this._keyboardPrototype._updateKeys =
                this._originalUpdateKeys;
        }

        // Refresh the current keyboard immediately.
        const keyboard = Main.keyboard?.keyboardActor;
        keyboard?._updateKeys();
    }

    disable() {
        // Restore GNOME's original behaviour.
        this._keyboardPrototype._updateKeys =
            this._originalUpdateKeys;

        const keyboard = Main.keyboard?.keyboardActor;
        keyboard?._updateKeys();

        this._indicator.quickSettingsItems.forEach(item => {
            item.destroy();
        });
        this._indicator.destroy();

        this._toggle = null;
        this._indicator = null;
        this._keyboardPrototype = null;
        this._originalUpdateKeys = null;
    }
}

