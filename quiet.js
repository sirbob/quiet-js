/* Copyright 2016, Brian Armstrong
 * quiet.js includes compiled portions from other sources
 *  - liquid DSP, Copyright (c) 2007-2016 Joseph Gaeddert
 *  - libjansson, Copyright (c) 2009-2016 Petri Lehtinen
 *  - emscripten, Copyright (c) 2010-2016 Emscripten authors
 */

/** @namespace */
var Quiet = (function() {
    // sampleBufferSize is the number of audio samples we'll write per onaudioprocess call
    // must be a power of two. we choose the absolute largest permissible value
    // we implicitly assume that the browser will play back a written buffer without any gaps
    var sampleBufferSize = 16384;

    // initialization flags
    var emscriptenInitialized = false;
    var profilesFetched = false;

    // profiles is the string content of quiet-profiles.json
    var profiles;

    // our local instance of window.AudioContext
    var audioCtx;

    // consumer callbacks. these fire once quiet is ready to create transmitter/receiver
    var readyCallbacks = [];
    var readyErrbacks = [];
    var failReason = "";

    // these are used for receiver only
    var gUM;
    var audioInput;
    var audioInputFailedReason = "";
    var audioInputReadyCallbacks = [];
    var audioInputFailedCallbacks = [];
    var frameBufferSize = Math.pow(2, 14);

    // anti-gc
    var receivers = [];

    // isReady tells us if we can start creating transmitters and receivers
    // we need the emscripten portion to be running and we need our
    // async fetch of the profiles to be completed
    function isReady() {
        return emscriptenInitialized && profilesFetched;
    };

    function isFailed() {
        return failReason !== "";
    };

    // start gets our AudioContext and notifies consumers that quiet can be used
    function start() {
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        console.log(audioCtx.sampleRate);
        var len = readyCallbacks.length;
        for (var i = 0; i < len; i++) {
            readyCallbacks[i]();
        }
    };

    function fail(reason) {
        failReason = reason;
        var len = readyErrbacks.length;
        for (var i = 0; i < len; i++) {
            readyErrbacks[i](reason);
        }
    };

    function checkInitState() {
        if (isReady()) {
            start();
        }
    };

    function onProfilesFetch(p) {
        profiles = p;
        profilesFetched = true;
        checkInitState();
    };

    // this is intended to be called only by emscripten
    function onEmscriptenInitialized() {
        emscriptenInitialized = true;
        checkInitState();
    };

    function setProfilesPrefix(prefix) {
        if (profilesFetched) {
            return;
        }
        if (!prefix.endsWith("/")) {
            prefix += "/";
        }
        var profilesPath = prefix + "quiet-profiles.json";

        var fetch = new Promise(function(resolve, reject) {
            var xhr = new XMLHttpRequest();
            xhr.overrideMimeType("application/json");
            xhr.open("GET", profilesPath, true);
            xhr.onload = function() {
                if (this.status >= 200 && this.status < 300) {
                    resolve(this.responseText);
                } else {
                    reject(this.statusText);
                }
            };
            xhr.onerror = function() {
                reject(this.statusText);
            };
            xhr.send();
        });

        fetch.then(function(body) {
            onProfilesFetch(body);
        }, function(err) {
            fail("fetch of quiet-profiles.json failed: " + err);
        });
    };

    function setMemoryInitializerPrefix(prefix) {
        Module.memoryInitializerPrefixURL = prefix;
    };

    function setLibfecPrefix(prefix) {
        Module.dynamicLibraries = Module.dynamicLibraries || [];
        Module.dynamicLibraries.push(prefix + "libfec.js");
    };

    /**
     * Callback to notify user that quiet.js failed to initialize
     *
     * @callback onError
     * @memberof Quiet
     * @param {string} reason - error message related to failure
     */

    /**
     * Add a callback to be called when Quiet is ready for use, e.g. when transmitters and receivers can be created.
     * @function addReadyCallback
     * @memberof Quiet
     * @param {function} c - The user function which will be called
     * @param {onError} [onError] - User errback function
     * @example
     * addReadyCallback(function() { console.log("ready!"); });
     */
    function addReadyCallback(c, errback) {
        if (isReady()) {
            c();
            return;
        }
        readyCallbacks.push(c);
        if (errback !== undefined) {
            if (isFailed()) {
                errback(failReason);
                return;
            }
            readyErrbacks.push(errback);
        }
    };

    /**
     * Callback to notify user that quiet.js failed to initialize
     *
     * @callback onError
     * @memberof Quiet
     * @param {string} reason - error message related to failure
     */

    /**
     * Initialize Quiet and set up a callback to be called when Quiet is ready
     * @function init
     * @memberof Quiet
     * @param {object} opts - configuration options
     * @param {string} opts.profilesPrefix - path prefix to quiet-profiles.json
     *   this file configures transmitter and receiver parameters
     * @param {string} opts.memoryInitializerPrefix - path prefix to quiet-emscripten.js.mem
     * @param {string} [opts.libfecPrefix] - path prefix to libfec.js
     * @param {function} [opts.onReady] - Quiet ready callback
     * @param {onError} [opts.onError] - User errback function
     * @example
     * Quiet.init({
     *   profilesPrefix: "/",  // fetches /quiet-profiles.json
     *   memoryInitializerPrefix: "/",  // fetches /quiet-emscripten.js.mem
     *   libfecPrefix: "/",  // fetches /libfec.js
     *   onReady: function() { console.log("quiet is ready"); },
     *   onError: function(reason) { console.log("quiet failed to start: " + reason); }
     * });
     */
    function init(opts) {
        if (opts.profilesPrefix !== undefined) {
            setProfilesPrefix(opts.profilesPrefix);
        }

        if (opts.memoryInitializerPrefix !== undefined) {
            setMemoryInitializerPrefix(opts.memoryInitializerPrefix);
        }

        if (opts.libfecPrefix !== undefined) {
            setLibfecPrefix(opts.libfecPrefix);
        }

        if (opts.onReady !== undefined) {
            if (opts.onError !== undefined) {
                addReadyCallback(opts.onReady, opts.onError);
            } else {
                addReadyCallback(opts.onReady);
            }
        }
    };



    /**
     * Callback for user to provide data to a Quiet transmitter
     * @callback transmit
     * @memberof Quiet
     * @param {ArrayBuffer} payload - bytes which will be encoded and sent to speaker
     * @example
     * transmit(Quiet.str2ab("Hello, World!"));
     */

    /**
     * @typedef Transmitter
     * @type object
     * @property {transmit} transmit - queue up array buffer and begin transmitting
     * @property {function} destroy - immediately stop playback and release all resources
     */

    /**
     * Create a new transmitter configured by the given profile name.
     * @function transmitter
     * @memberof Quiet
     * @param {object} opts - transmitter params
     * @param {string|object} opts.profile - name of profile to use, must be a key in quiet-profiles.json OR an object which contains a single profile
     * @param {function} [opts.onFinish] - user callback which will notify user when playback of all data in queue is complete
     *    if the user calls transmit multiple times before waiting for onFinish, then onFinish will be called only once after
     *    all of the data has been played out
     * @returns {Transmitter} - Transmitter object
     * @example
     * var tx = transmitter({profile: "robust", onFinish: function () { console.log("transmission complete"); }});
     * tx.transmit(Quiet.str2ab("Hello, World!"));
     */
    function transmitter(opts) {
        var profile = opts.profile;
        var c_profiles, c_profile;
        if (typeof profile === 'object') {
            c_profiles = Module.intArrayFromString(JSON.stringify({"profile": profile}));
            c_profile = Module.intArrayFromString("profile");
        } else {
            // get an encoder_options object for our quiet-profiles.json and profile key
            c_profiles = Module.intArrayFromString(profiles);
            c_profile = Module.intArrayFromString(profile);
        }

        var done = opts.onFinish;

        var opt = Module.ccall('quiet_encoder_profile_str', 'pointer', ['array', 'array'], [c_profiles, c_profile]);

        // libquiet internally works at 44.1kHz but the local sound card
        // may be a different rate. we inform quiet about that here
        var encoder = Module.ccall('quiet_encoder_create', 'pointer', ['pointer', 'number'], [opt, audioCtx.sampleRate]);

        Module.ccall('free', null, ['pointer'], [opt]);

        // enable close_frame which prevents data frames from overlapping multiple
        // sample buffers. this is very convenient if our system is not fast enough
        // to feed the sound card without any gaps between subsequent buffers due
        // to e.g. gc pause. inform quiet about our sample buffer size here
        var frame_len = Module.ccall('quiet_encoder_clamp_frame_len', 'number', ['pointer', 'number'], [encoder, sampleBufferSize]);
        var samples = Module.ccall('malloc', 'pointer', ['number'], [4 * sampleBufferSize]);

        // yes, this is pointer arithmetic, in javascript :)
        var sample_view = Module.HEAPF32.subarray((samples/4), (samples/4) + sampleBufferSize);

        var dummy_osc;

        // we'll start and stop transmitter as needed
        //   if we have something to send, start it
        //   if we are done talking, stop it
        var running = false;
        var transmitter;

        var onaudioprocess = function(e) {
            var output_l = e.outputBuffer.getChannelData(0);

            if (played === true) {
                // we've already played what's in sample_view, and it hasn't been
                //   rewritten for whatever reason, so just play out silence
                for (var i = 0; i < sampleBufferSize; i++) {
                    output_l[i] = 0;
                }
                return;
            }

            played = true;

            output_l.set(sample_view);
            window.setTimeout(writebuf, 0);
        };

        var startTransmitter = function () {
            if (transmitter === undefined) {
                // we have to start transmitter here because mobile safari wants it to be in response to a
                // user action
                var script_processor = (audioCtx.createScriptProcessor || audioCtx.createJavaScriptNode);
                // we want a single input because some implementations will not run a node without some kind of source
                // we want two outputs so that we can explicitly silence the right channel and no mixing will occur
                transmitter = script_processor.call(audioCtx, sampleBufferSize, 1, 2);
                transmitter.onaudioprocess = onaudioprocess;
                // put an input node on the graph. some browsers require this to run our script processor
                // this oscillator will not actually be used in any way
                dummy_osc = audioCtx.createOscillator();
                dummy_osc.type = 'square';
                dummy_osc.frequency.value = 420;

            }
            dummy_osc.connect(transmitter);
            transmitter.connect(audioCtx.destination);
            running = true;
        };

        var stopTransmitter = function () {
            dummy_osc.disconnect();
            transmitter.disconnect();
            running = false;
        };

        // we are only going to keep one chunk of samples around
        // ideally there will be a 1:1 sequence between writebuf and onaudioprocess
        // but just in case one gets ahead of the other, this flag will prevent us
        // from throwing away a buffer or playing a buffer twice
        var played = true;

        // payload is a list of ArrayBuffers, each one frame or smaller in length
        var payload = [];
        var payloadView = new Uint8Array(payload);

        // unfortunately, we need to flush out the browser's sound sample buffer ourselves
        // the way we do this is by writing empty blocks once we're done and *then* we can disconnect
        var empties_written = 0;

        // writebuf calls _send and _emit on the encoder
        // first we push as much payload as will fit into encoder's tx queue
        // then we create the next sample block (if played = true)
        var writebuf = function() {
            // fill as much of quiet's transmit queue as possible
            var frame_available = false;
            while(true) {
                var frame = payload.shift();
                if (frame === undefined) {
                    break;
                }
                frame_available = true;
                var written = Module.ccall('quiet_encoder_send', 'number', ['pointer', 'array', 'number'], [encoder, new Uint8Array(frame), frame.byteLength]);
                if (written === -1) {
                    payload.unshift(frame);
                    break;
                }
            }

            if (frame_available === true && running === false) {
                startTransmitter();
            }

            // now set the sample block
            if (played === false) {
                // the existing sample block has yet to be played
                // we are done
                return;
            }

            var written = Module.ccall('quiet_encoder_emit', 'number', ['pointer', 'pointer', 'number'], [encoder, samples, sampleBufferSize]);

            // libquiet notifies us that the payload is finished by
            // returning written < number of samples we asked for
            if (frame_available === false && written === 0) {
                if (empties_written < 3) {
                    // flush out browser's sound sample buffer before quitting
                    for (var i = 0; i < sampleBufferSize; i++) {
                        sample_view[i] = 0;
                    }
                    empties_written++;
                    played = false;
                    return;
                }
                // looks like we are done
                // user callback
                if (done !== undefined) {
                        done();
                }
                if (running === true) {
                    stopTransmitter();
                }
                return;
            }

            played = false;
            empties_written = 0;

            // in this case, we are sending data, but the whole block isn't full (we're near the end)
            if (written < sampleBufferSize) {
                // be extra cautious and 0-fill what's left
                //   (we want the end of transmission to be silence, not potentially loud noise)
                for (var i = written; i < sampleBufferSize; i++) {
                    sample_view[i] = 0;
                }
            }

        };

        var transmit = function(buf) {
            // slice up into frames and push the frames to a list
            for (var i = 0; i < buf.byteLength; ) {
                var frame = buf.slice(i, i + frame_len);
                i += frame.byteLength;
                payload.push(frame);
            }
            // now do an update. this may or may not write samples
            writebuf();
        };

        var destroy = function() {
            Module.ccall('free', null, ['pointer'], [samples]);
            Module.ccall('quiet_encoder_destroy', null, ['pointer'], [encoder]);
            if (running === true) {
                stopTransmitter();
            }
        };

        return {
            transmit: transmit,
            destroy: destroy
        };
    };

    // receiver functions

    function audioInputReady() {
        var len = audioInputReadyCallbacks.length;
        for (var i = 0; i < len; i++) {
            audioInputReadyCallbacks[i]();
        }
    };

    function audioInputFailed(reason) {
        audioInputFailedReason = reason;
        var len = audioInputFailedCallbacks.length;
        for (var i = 0; i < len; i++) {
            audioInputFailedCallbacks[i](audioInputFailedReason);
        }
    };

    function addAudioInputReadyCallback(c, errback) {
        if (errback !== undefined) {
            if (audioInputFailedReason !== "") {
                errback(audioInputFailedReason);
                return
            }
            audioInputFailedCallbacks.push(errback);
        }
        if (audioInput instanceof MediaStreamAudioSourceNode) {
            c();
            return
        }
        audioInputReadyCallbacks.push(c);
    }

    function gUMConstraints() {
        if (navigator.webkitGetUserMedia !== undefined) {
            return {
                audio: {
                    optional: [
                      {googAutoGainControl: false},
                      {googAutoGainControl2: false},
                      {echoCancellation: false},
                      {googEchoCancellation: false},
                      {googEchoCancellation2: false},
                      {googDAEchoCancellation: false},
                      {googNoiseSuppression: false},
                      {googNoiseSuppression2: false},
                      {googHighpassFilter: false},
                      {googTypingNoiseDetection: false},
                      {googAudioMirroring: false}
                    ]
                }
            };
        }
        if (navigator.mozGetUserMedia !== undefined) {
            return {
                audio: {
                    echoCancellation: false,
                    mozAutoGainControl: false,
                    mozNoiseSuppression: false
                }
            };

        }
        return {
            audio: {
                echoCancellation: false
            }
        };
    };


    function createAudioInput() {
        audioInput = 0; // prevent others from trying to create
        gUM.call(navigator, gUMConstraints(),
            function(e) {
                audioInput = audioCtx.createMediaStreamSource(e);

                // stash a very permanent reference so this isn't collected
                window.quiet_receiver_anti_gc = audioInput;

                audioInputReady();
            }, function(reason) {
                audioInputFailed(reason.name);
        });
    };

    /**
     * @typedef Receiver
     * @type object
     * @property {function} destroy - immediately stop sampling microphone and release all resources
     */

    /**
     * Callback used by receiver to notify user that a frame was received but
     * failed checksum. Frames that fail checksum are not sent to onReceive.
     *
     * @callback onReceiveFail
     * @memberof Quiet
     * @param {number} total - total number of frames failed across lifetime of receiver
     */

    /**
     * Callback used by receiver to notify user of errors in creating receiver.
     * This is a callback because frequently this will result when the user denies
     * permission to use the mic, which happens long after the call to create
     * the receiver.
     *
     * @callback onReceiverCreateFail
     * @memberof Quiet
     * @param {string} reason - error message related to create fail
     */

    /**
     * Callback used by receiver to notify user of data received via microphone/line-in.
     *
     * @callback onReceive
     * @memberof Quiet
     * @param {ArrayBuffer} payload - chunk of data received
     */

    /**
     * Create a new receiver with the profile specified by profile (should match profile of transmitter).
     * @function receiver
     * @memberof Quiet
     * @param {object} opts - receiver params
     * @param {string|object} opts.profile - name of profile to use, must be a key in quiet-profiles.json OR an object which contains a complete profile
     * @param {onReceive} opts.onReceive - callback which receiver will call to send user received data
     * @param {onReceiverCreateFail} [opts.onCreateFail] - callback to notify user that receiver could not be created
     * @param {onReceiveFail} [opts.onReceiveFail] - callback to notify user that receiver received corrupted data
     * @returns {Receiver} - Receiver object
     * @example
     * receiver({profile: "robust", onReceive: function(payload) { console.log("received chunk of data: " + Quiet.ab2str(payload)); }});
     */
    function receiver(opts) {
        var profile = opts.profile;
        var c_profiles, c_profile;
        if (typeof profile === 'object') {
            c_profiles = Module.intArrayFromString(JSON.stringify({"profile": profile}));
            c_profile = Module.intArrayFromString("profile");
        } else {
            c_profiles = Module.intArrayFromString(profiles);
            c_profile = Module.intArrayFromString(profile);
        }
        var opt = Module.ccall('quiet_decoder_profile_str', 'pointer', ['array', 'array'], [c_profiles, c_profile]);

        // quiet creates audioCtx when it starts but it does not create an audio input
        // getting microphone access requires a permission dialog so only ask for it if we need it
        if (gUM === undefined) {
            gUM = (navigator.getUserMedia || navigator.webkitGetUserMedia || navigator.mozGetUserMedia);
        }

        if (gUM === undefined) {
            // we couldn't find a suitable getUserMedia, so fail fast
            if (opts.onCreateFail !== undefined) {
                opts.onCreateFail("getUserMedia undefined (mic not supported by browser)");
            }
            return;
        }

        if (audioInput === undefined) {
            createAudioInput()
        }

        // TODO investigate if this still needs to be placed on window.
        // seems this was done to keep it from being collected
        var scriptProcessor = audioCtx.createScriptProcessor(16384, 2, 1);
        receivers.push(scriptProcessor);

        // inform quiet about our local sound card's sample rate so that it can resample to its internal sample rate
        var decoder = Module.ccall('quiet_decoder_create', 'pointer', ['pointer', 'number'], [opt, audioCtx.sampleRate]);

        Module.ccall('free', null, ['pointer'], [opt]);

        var samples = Module.ccall('malloc', 'pointer', ['number'], [4 * sampleBufferSize]);

        var frame = Module.ccall('malloc', 'pointer', ['number'], [frameBufferSize]);

        var readbuf = function() {
            while (true) {
                var read = Module.ccall('quiet_decoder_recv', 'number', ['pointer', 'pointer', 'number'], [decoder, frame, frameBufferSize]);
                if (read === -1) {
                    break;
                }
                // convert from emscripten bytes to js string. more pointer arithmetic.
                var frameArray = Module.HEAP8.slice(frame, frame + read);
                opts.onReceive(frameArray);
            }
        };

        var lastChecksumFailCount = 0;
        var consume = function() {
            Module.ccall('quiet_decoder_consume', 'number', ['pointer', 'pointer', 'number'], [decoder, samples, sampleBufferSize]);

            window.setTimeout(readbuf, 0);

            var currentChecksumFailCount = Module.ccall('quiet_decoder_checksum_fails', 'number', ['pointer'], [decoder]);
            if ((opts.onReceiveFail !== undefined) && (currentChecksumFailCount > lastChecksumFailCount)) {
                window.setTimeout(function() { opts.onReceiveFail(currentChecksumFailCount); }, 0);
            }
            lastChecksumFailCount = currentChecksumFailCount;
        }

        scriptProcessor.onaudioprocess = function(e) {
            var input = e.inputBuffer.getChannelData(0);
            var sample_view = Module.HEAPF32.subarray(samples/4, samples/4 + sampleBufferSize);
            sample_view.set(input);

            window.setTimeout(consume, 0);
        }

        // if this is the first receiver object created, wait for our input node to be created
        addAudioInputReadyCallback(function() {
            audioInput.connect(scriptProcessor);
        }, opts.onCreateFail);

        // more unused nodes in the graph that some browsers insist on having
        var fakeGain = audioCtx.createGain();
        fakeGain.value = 0;
        scriptProcessor.connect(fakeGain);
        fakeGain.connect(audioCtx.destination);

        var destroy = function() {
            fakeGain.disconnect();
            scriptProcessor.disconnect();
            Module.ccall('free', null, ['pointer'], [samples]);
            Module.ccall('free', null, ['pointer'], [frame]);
            Module.ccall('quiet_decoder_destroy', null, ['pointer'], [decoder]);
        };

        return {
            destroy: destroy
        }
    };

    /**
     * Convert a string to array buffer in UTF8
     * @function str2ab
     * @memberof Quiet
     * @param {string} s - string to be converted
     * @returns {ArrayBuffer} buf - converted arraybuffer
     */
    function str2ab(s) {
        var s_utf8 = unescape(encodeURIComponent(s));
        var buf = new ArrayBuffer(s_utf8.length);
        var bufView = new Uint8Array(buf);
        for (var i = 0; i < s_utf8.length; i++) {
            bufView[i] = s_utf8.charCodeAt(i);
        }
        return buf;
    };

    /**
     * Convert an array buffer in UTF8 to string
     * @function ab2str
     * @memberof Quiet
     * @param {ArrayBuffer} ab - array buffer to be converted
     * @returns {string} s - converted string
     */
    function ab2str(ab) {
        return decodeURIComponent(escape(String.fromCharCode.apply(null, new Uint8Array(ab))));
    };

    /**
     * Merge 2 ArrayBuffers
     * This is a convenience function to assist user receiver functions that
     * want to aggregate multiple payloads.
     * @function mergeab
     * @memberof Quiet
     * @param {ArrayBuffer} ab1 - beginning ArrayBuffer
     * @param {ArrayBuffer} ab2 - ending ArrayBuffer
     * @returns {ArrayBuffer} buf - ab1 merged with ab2
     */
    function mergeab(ab1, ab2) {
        var tmp = new Uint8Array(ab1.byteLength + ab2.byteLength);
        tmp.set(new Uint8Array(ab1), 0);
        tmp.set(new Uint8Array(ab2), ab1.byteLength);
        return tmp.buffer;
    };

    return {
        emscriptenInitialized: onEmscriptenInitialized,
        addReadyCallback: addReadyCallback,
        init: init,
        transmitter: transmitter,
        receiver: receiver,
        str2ab: str2ab,
        ab2str: ab2str,
        mergeab: mergeab
    };
})();

// extend emscripten Module
var Module = {
    onRuntimeInitialized: Quiet.emscriptenInitialized,
    memoryInitializerPrefixURL: ""
};