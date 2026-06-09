'use strict';

// screencast(handle, onFrame, opts) → { started, stop }
//
// Start Page.startScreencast on the handle's CDPSession and deliver each frame to onFrame in the
// FRAME-CHANNEL SHAPE below. The single most important detail: every frame MUST be
// Page.screencastFrameAck'd or Chrome stops emitting after a few frames. We ack first-thing,
// before invoking the consumer, so a slow or throwing consumer can never stall the stream.
//
// handle.cdp is a Playwright CDPSession: .send(method, params) → Promise, .on(event, fn) /
// .off(event, fn) for events. (.on returns the session, not an unsubscribe fn, so we keep a named
// handler and remove it explicitly on stop.)
//
// FRAME-CHANNEL SHAPE (the object onFrame receives — the contract T2 broadcasts as
// {type:'web-chat-frame', frame} and T3's client canvas renders):
//   {
//     format:          'jpeg' | 'png',
//     data:            string,   // base64-encoded image bytes
//     dataUrl:         string,   // 'data:image/<format>;base64,<data>' — drop into <img>/canvas
//     deviceWidth:     number,   // DIP — size the canvas backing store to this
//     deviceHeight:    number,   // DIP
//     offsetTop:       number,
//     pageScaleFactor: number,
//     scrollOffsetX:   number,
//     scrollOffsetY:   number,
//     timestamp:       number,   // frame swap time (Network.TimeSinceEpoch)
//     frame:           number,   // CDP screencast frame number (the acked sessionId)
//   }

function screencast(handle, onFrame, opts = {}) {
  if (typeof onFrame !== 'function') {
    throw new TypeError('screencast(handle, onFrame): onFrame must be a function');
  }
  const cdp = handle.cdp;
  const format = opts.format || 'jpeg';
  let stopped = false;

  const handler = (params) => {
    if (!params) return;
    const { data, metadata = {}, sessionId } = params;

    // ACK immediately — keep the stream flowing no matter what the consumer does.
    cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});

    if (stopped) return;
    try {
      onFrame({
        format,
        data,
        dataUrl: `data:image/${format};base64,${data}`,
        deviceWidth: metadata.deviceWidth,
        deviceHeight: metadata.deviceHeight,
        offsetTop: metadata.offsetTop,
        pageScaleFactor: metadata.pageScaleFactor,
        scrollOffsetX: metadata.scrollOffsetX,
        scrollOffsetY: metadata.scrollOffsetY,
        timestamp: metadata.timestamp,
        frame: sessionId,
      });
    } catch (_) {
      /* a consumer error must never kill the screencast */
    }
  };

  cdp.on('Page.screencastFrame', handler);

  const started = cdp.send('Page.startScreencast', {
    format,
    quality: opts.quality != null ? opts.quality : 85,
    maxWidth: opts.maxWidth != null ? opts.maxWidth : 2560,
    maxHeight: opts.maxHeight != null ? opts.maxHeight : 1600,
    everyNthFrame: opts.everyNthFrame != null ? opts.everyNthFrame : 1,
  });

  return {
    started,
    async stop() {
      stopped = true;
      try {
        cdp.off('Page.screencastFrame', handler);
      } catch (_) {
        /* ignore */
      }
      await cdp.send('Page.stopScreencast').catch(() => {});
    },
  };
}

module.exports = { screencast };
