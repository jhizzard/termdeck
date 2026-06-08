'use strict';

// Input forwarding + programmatic text insertion.
//
// sendInput(handle, evt)  — forward ONE raw mouse/keyboard event to the page. This is the path
//   the human's drive-through takes: the client canvas turns a DOM MouseEvent/KeyboardEvent into
//   an `evt` of one of the shapes below and ships it here verbatim.
//
//   Mouse evt:  { kind?:'mouse', type:'mousePressed'|'mouseReleased'|'mouseMoved'|'mouseWheel',
//                 x, y, button?:'none'|'left'|'middle'|'right'|'back'|'forward',
//                 buttons?, clickCount?, modifiers?, deltaX?, deltaY?, pointerType? }
//   Key evt:    { kind?:'key', type:'keyDown'|'keyUp'|'rawKeyDown'|'char',
//                 key?, code?, text?, unmodifiedText?, windowsVirtualKeyCode?|keyCode?,
//                 nativeVirtualKeyCode?, modifiers?, autoRepeat?, isKeypad?, location? }
//
// insertText(handle, text) — insert a whole string at the focused element as if typed/IME'd
//   (Input.insertText). This is the clean primitive T3's grok.inject composes with the composer
//   selector: focus composer → insertText(prompt) → press Enter. No per-character keycodes needed.

function compact(obj) {
  const out = {};
  for (const k of Object.keys(obj)) if (obj[k] !== undefined) out[k] = obj[k];
  return out;
}

const MOUSE_TYPES = /^(mousePressed|mouseReleased|mouseMoved|mouseWheel)$/;

function sendInput(handle, evt) {
  if (!evt || typeof evt !== 'object') {
    throw new TypeError('sendInput(handle, evt): evt must be an object');
  }
  const cdp = handle.cdp;
  const type = evt.type;
  const isMouse = evt.kind === 'mouse' || MOUSE_TYPES.test(type || '');

  if (isMouse) {
    return cdp.send(
      'Input.dispatchMouseEvent',
      compact({
        type,
        x: evt.x,
        y: evt.y,
        button: evt.button || 'none',
        buttons: evt.buttons,
        clickCount:
          evt.clickCount != null
            ? evt.clickCount
            : type === 'mousePressed' || type === 'mouseReleased'
            ? 1
            : 0,
        modifiers: evt.modifiers || 0,
        deltaX: evt.deltaX,
        deltaY: evt.deltaY,
        pointerType: evt.pointerType,
      })
    );
  }

  // Keyboard.
  return cdp.send(
    'Input.dispatchKeyEvent',
    compact({
      type, // keyDown | keyUp | rawKeyDown | char
      key: evt.key,
      code: evt.code,
      text: evt.text,
      unmodifiedText: evt.unmodifiedText != null ? evt.unmodifiedText : evt.text,
      windowsVirtualKeyCode:
        evt.windowsVirtualKeyCode != null ? evt.windowsVirtualKeyCode : evt.keyCode,
      nativeVirtualKeyCode:
        evt.nativeVirtualKeyCode != null ? evt.nativeVirtualKeyCode : evt.keyCode,
      modifiers: evt.modifiers || 0,
      autoRepeat: evt.autoRepeat,
      isKeypad: evt.isKeypad,
      location: evt.location,
    })
  );
}

function insertText(handle, text) {
  return handle.cdp.send('Input.insertText', { text: String(text) });
}

// Convenience: emit a full printable keystroke (keyDown carrying text, then keyUp). Used by the
// fixture test to prove human-style key forwarding; also handy for sending Enter/Tab/etc.
async function typeKey(handle, { key, code, text, keyCode, modifiers } = {}) {
  await sendInput(handle, { type: 'keyDown', key, code, text, windowsVirtualKeyCode: keyCode, modifiers });
  await sendInput(handle, { type: 'keyUp', key, code, windowsVirtualKeyCode: keyCode, modifiers });
}

module.exports = { sendInput, insertText, typeKey };
