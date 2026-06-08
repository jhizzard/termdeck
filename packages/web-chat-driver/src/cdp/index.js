'use strict';

// Public CDP surface. Two equivalent calling styles are supported:
//   handle-method form (preferred, multi-panel safe):  handle.screencast(cb) / handle.sendInput(evt)
//   standalone form (matches the PLANNING shorthand):   cdp.screencast(handle, cb) / cdp.sendInput(handle, evt)
// Each web-chat panel gets its own `handle` (its own Chrome target), so the handle-method form
// is the one T2 should wire per session.

const { attach } = require('./attach');
const { screencast } = require('./screencast');
const { sendInput, insertText, typeKey } = require('./input');
const profile = require('./profile');

module.exports = {
  attach,
  screencast,
  sendInput,
  insertText,
  typeKey,
  profile,
};
