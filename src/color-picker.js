// Self-made colour picker popover: saturation/value square + hue bar + hex
// field. Replaces the native <input type="color"> (unstylable, jarring OS
// chrome). One instance at a time; closes on outside press, Escape, scroll or
// resize. Emits `onInput(hex)` live during drags and `onClose()` on dismissal.
//
// No dependencies: it only touches document/window, never state/dom.

export function hexToHsv(hex) {
    const value = parseInt(String(hex).slice(1), 16);
    const r = ((value >> 16) & 255) / 255;
    const g = ((value >> 8) & 255) / 255;
    const b = (value & 255) / 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const d = max - min;
    let h = 0;
    if (d !== 0) {
        if (max === r) h = 60 * (((g - b) / d) % 6);
        else if (max === g) h = 60 * ((b - r) / d + 2);
        else h = 60 * ((r - g) / d + 4);
    }
    if (h < 0) h += 360;
    return { h, s: max === 0 ? 0 : d / max, v: max };
}

export function hsvToHex(h, s, v) {
    const c = v * s;
    const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
    const m = v - c;
    let r = 0, g = 0, b = 0;
    if (h < 60) [r, g, b] = [c, x, 0];
    else if (h < 120) [r, g, b] = [x, c, 0];
    else if (h < 180) [r, g, b] = [0, c, x];
    else if (h < 240) [r, g, b] = [0, x, c];
    else if (h < 300) [r, g, b] = [x, 0, c];
    else [r, g, b] = [c, 0, x];
    return `#${[r, g, b].map((n) => Math.round((n + m) * 255).toString(16).padStart(2, "0")).join("")}`;
}

const _clamp01 = (n) => Math.min(1, Math.max(0, n));

let active = null; // { root, cleanup, onClose }

export function closeColorPicker() {
    if (!active) return;
    const { root, cleanup, onClose } = active;
    active = null;
    cleanup();
    root.remove();
    onClose?.();
}

export function openColorPicker({ anchor, value, onInput, onClose }) {
    closeColorPicker();

    let { h, s, v } = hexToHsv(/^#[0-9a-f]{6}$/i.test(String(value || "")) ? value : "#e8365d");

    const root = document.createElement("div");
    root.className = "color-picker-pop";
    root.innerHTML = `
        <div class="cp-sv">
            <div class="cp-sv-white"></div>
            <div class="cp-sv-black"></div>
            <div class="cp-thumb cp-sv-thumb"></div>
        </div>
        <div class="cp-hue">
            <div class="cp-thumb cp-hue-thumb"></div>
        </div>
        <div class="cp-row">
            <span class="cp-swatch"></span>
            <input class="cp-hex" type="text" spellcheck="false" maxlength="7" aria-label="Hex">
        </div>
    `;
    document.body.appendChild(root);

    const svEl = root.querySelector(".cp-sv");
    const svThumb = root.querySelector(".cp-sv-thumb");
    const hueEl = root.querySelector(".cp-hue");
    const hueThumb = root.querySelector(".cp-hue-thumb");
    const swatchEl = root.querySelector(".cp-swatch");
    const hexInput = root.querySelector(".cp-hex");

    const apply = ({ skipHexInput = false } = {}) => {
        const hex = hsvToHex(h, s, v);
        svEl.style.backgroundColor = `hsl(${h}, 100%, 50%)`;
        svThumb.style.left = `${s * 100}%`;
        svThumb.style.top = `${(1 - v) * 100}%`;
        svThumb.style.backgroundColor = hex;
        hueThumb.style.left = `${(h / 360) * 100}%`;
        hueThumb.style.backgroundColor = `hsl(${h}, 100%, 50%)`;
        swatchEl.style.backgroundColor = hex;
        // Don't rewrite the field mid-typing — it would fight the caret.
        if (!skipHexInput) hexInput.value = hex;
        onInput?.(hex);
    };

    const dragFrom = (el, update) => {
        el.addEventListener("pointerdown", (event) => {
            event.preventDefault();
            el.setPointerCapture(event.pointerId);
            update(event);
            const move = (ev) => update(ev);
            const up = () => {
                el.removeEventListener("pointermove", move);
                el.removeEventListener("pointerup", up);
            };
            el.addEventListener("pointermove", move);
            el.addEventListener("pointerup", up);
        });
    };

    dragFrom(svEl, (event) => {
        const rect = svEl.getBoundingClientRect();
        s = _clamp01((event.clientX - rect.left) / rect.width);
        v = 1 - _clamp01((event.clientY - rect.top) / rect.height);
        apply();
    });
    dragFrom(hueEl, (event) => {
        const rect = hueEl.getBoundingClientRect();
        h = _clamp01((event.clientX - rect.left) / rect.width) * 359.999;
        apply();
    });

    hexInput.addEventListener("input", () => {
        let raw = hexInput.value.trim();
        if (raw && !raw.startsWith("#")) raw = `#${raw}`;
        if (!/^#[0-9a-f]{6}$/i.test(raw)) return;
        ({ h, s, v } = hexToHsv(raw.toLowerCase()));
        apply({ skipHexInput: true });
    });

    // Capture phase so Escape closes JUST the picker, not the settings modal
    // behind it (the modal's own handler listens on the bubble phase).
    const onKeyDown = (event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        closeColorPicker();
    };
    const onOutsidePress = (event) => {
        if (root.contains(event.target) || anchor?.contains?.(event.target)) return;
        closeColorPicker();
    };
    const onDetach = () => closeColorPicker();
    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("pointerdown", onOutsidePress, true);
    window.addEventListener("scroll", onDetach, true);
    window.addEventListener("resize", onDetach);

    active = {
        root,
        onClose,
        cleanup: () => {
            document.removeEventListener("keydown", onKeyDown, true);
            document.removeEventListener("pointerdown", onOutsidePress, true);
            window.removeEventListener("scroll", onDetach, true);
            window.removeEventListener("resize", onDetach);
        },
    };

    // Anchor below the swatch, clamped to the viewport; flip above when the
    // bottom edge would clip.
    const rect = anchor.getBoundingClientRect();
    const width = root.offsetWidth || 220;
    const height = root.offsetHeight || 250;
    let left = Math.min(Math.max(rect.left, 8), window.innerWidth - width - 8);
    let top = rect.bottom + 8;
    if (top + height > window.innerHeight - 8) {
        top = Math.max(8, rect.top - height - 8);
    }
    root.style.left = `${left}px`;
    root.style.top = `${top}px`;

    apply();
    hexInput.focus({ preventScroll: true });
    hexInput.select();
}
