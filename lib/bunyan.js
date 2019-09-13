/* eslint-disable one-var */

/* eslint-disable strict */
/*
  Logger class ( Logger() ) has a parameter `src` whose type is Boolean.
  The src parameter is used to enable 'src' automatic field with log call source info.
  So there will be a conversion to this.src: Boolean => String.
  Thus, when strict mode is enabled, the src.test.js won't pass.

  To enable strict mode, a breaking change (add a separate option under Logger class) is needed to bypass that conversion.
*/

/**
 * Copyright (c) 2017 Trent Mick.
 * Copyright (c) 2017 Joyent Inc.
 *
 * The bunyan logging library for node.js.
 *
 * -*- mode: js -*-
 * vim: expandtab:ts=4:sw=4
 */

const VERSION = '1.8.10';

/*
 * Bunyan log format version. This becomes the 'v' field on all log records.
 * This will be incremented if there is any backward incompatible change to
 * the log record format. Details will be in 'CHANGES.md' (the change log).
 */
const LOG_VERSION = 0;


let xxx = (s) => { // internal dev/debug logging
  const args = ['XXX: ' + s].concat(Array.prototype.slice.call(arguments, 1));
  console.error.apply(this, args);
};
xxx = () => {}; // comment out to turn on debug logging

const os = require('os');
const fs = require('fs');
let dtrace;

try {
  // eslint-disable-next-line node/no-missing-require
  dtrace = require('dtrace-provider');
} catch (e) {
  dtrace = null;
}

const util = require('util');
const assert = require('assert');
const EventEmitter = require('events').EventEmitter;
const stream = require('stream');

let safeJsonStringify, mv, sourceMapSupport;
try {
  safeJsonStringify = require('safe-json-stringify');
} catch (e) {
  safeJsonStringify = null;
}
if (process.env.BUNYAN_TEST_NO_SAFE_JSON_STRINGIFY) {
  safeJsonStringify = null;
}

// The 'mv' module is required for rotating-file stream support.
try {
  mv = require('mv');
} catch (e) {
  mv = null;
}

try {
  // eslint-disable-next-line node/no-extraneous-require
  sourceMapSupport = require('source-map-support');
} catch (_) {
  sourceMapSupport = null;
}


// ---- Internal support stuff

// ---- Levels

const TRACE = 10;
const DEBUG = 20;
const INFO = 30;
const WARN = 40;
const ERROR = 50;
const FATAL = 60;

const levelFromName = {
  'trace': TRACE,
  'debug': DEBUG,
  'info': INFO,
  'warn': WARN,
  'error': ERROR,
  'fatal': FATAL
};
let nameFromLevel = {};
Object.assign(nameFromLevel, levelFromName);

/**
 * A shallow copy of an object. Bunyan logging attempts to never cause
 * exceptions, so this function attempts to handle non-objects gracefully.
 */
function objCopy(obj) {
  if (obj == null) { // null or undefined
    return obj;
  } else if (Array.isArray(obj)) {
    return obj.slice();
  } else if (typeof obj === 'object') {
    const copy = Object.assign({}, obj);
    return copy;
  }
  return obj;
}

const { format } = require('util');

/**
 * Gather some caller info 3 stack levels up.
 * See <http://code.google.com/p/v8/wiki/JavaScriptStackTraceApi>.
 */
function getCaller3Info() {
  // Cannot access caller info in 'strict' mode.
  if (this === undefined) return;

  let obj = {};
  const saveLimit = Error.stackTraceLimit;
  const savePrepare = Error.prepareStackTrace;
  Error.stackTraceLimit = 3;

  Error.prepareStackTrace = (_, stack) => {
    let caller = stack[2];
    if (sourceMapSupport) caller = sourceMapSupport.wrapCallSite(caller);

    obj.file = caller.getFileName();
    obj.line = caller.getLineNumber();
    const func = caller.getFunctionName();
    if (func) obj.func = func;
  };
  Error.captureStackTrace(this, getCaller3Info);
  // eslint-disable-next-line no-unused-expressions
  this.stack;

  Error.stackTraceLimit = saveLimit;
  Error.prepareStackTrace = savePrepare;
  return obj;
}


function _indent(s, indent) {
  if (!indent) indent = '    ';
  const lines = s.split(/\r?\n/g);
  return indent + lines.join('\n' + indent);
}


/**
 * Warn about an bunyan processing error.
 *
 * @param msg {String} Message with which to warn.
 * @param dedupKey {String} Optional. A short string key for this warning to
 *      have its warning only printed once.
 */

let _warned;

if (!_warned) _warned = {};

function _warn(msg, dedupKey) {
  assert.ok(msg);
  if (dedupKey) {
    if (_warned[dedupKey]) return;
    _warned[dedupKey] = true;
  }
  process.stderr.write(msg + '\n');
}
function _haveWarned(dedupKey) {
  return _warned[dedupKey];
}

function ConsoleRawStream() {}
ConsoleRawStream.prototype.write = (rec) => {
  if (rec.level < INFO) {
    console.log(rec);
  } else if (rec.level < WARN) {
    console.info(rec);
  } else if (rec.level < ERROR) {
    console.warn(rec);
  } else {
    console.error(rec);
  }
};


// Dtrace probes.
// eslint-disable-next-line no-undef-init
let dtp;
const probes = dtrace && {};

/**
 * Resolve a level number, name (upper or lowercase) to a level number value.
 *
 * @param nameOrNum {String|Number} A level name (case-insensitive) or positive
 *      integer level.
 * @api public
 */
function resolveLevel(nameOrNum) {
  let level;
  const type = typeof nameOrNum;
  if (type === 'string') {
    level = levelFromName[nameOrNum.toLowerCase()];
    if (!level) {
      throw new Error(`unknown level name: "${nameOrNum}"`);
    }
  } else if (type !== 'number') {
    throw new TypeError(format('cannot resolve level: invalid arg (%s):', type, nameOrNum));
  } else if (nameOrNum < 0 || Math.floor(nameOrNum) !== nameOrNum) {
    throw new TypeError(`level is not a positive integer: ${nameOrNum}`);
  } else {
    level = nameOrNum;
  }
  return level;
}


function isWritable(obj) {
  if (obj instanceof stream.Writable) return true;
  return typeof obj.write === 'function';
}


// ---- Logger class

/**
 * Create a Logger instance.
 *
 * @param options {Object} See documentation for full details. At minimum
 *    this must include a 'name' string key. Configuration keys:
 *      - `streams`: specify the logger output streams. This is an array of
 *        objects with these fields:
 *          - `type`: The stream type. See README.md for full details.
 *            Often this is implied by the other fields. Examples are
 *            'file', 'stream' and "raw".
 *          - `level`: Defaults to 'info'.
 *          - `path` or `stream`: The specify the file path or writeable
 *            stream to which log records are written. E.g.
 *            `stream: process.stdout`.
 *          - `closeOnExit` (boolean): Optional. Default is true for a
 *            'file' stream when `path` is given, false otherwise.
 *        See README.md for full details.
 *      - `level`: set the level for a single output stream (cannot be used
 *        with `streams`)
 *      - `stream`: the output stream for a logger with just one, e.g.
 *        `process.stdout` (cannot be used with `streams`)
 *      - `serializers`: object mapping log record field names to
 *        serializing functions. See README.md for details.
 *      - `src`: Boolean (default false). Set true to enable 'src' automatic
 *        field with log call source info.
 *    All other keys are log record fields.
 *
 * An alternative *internal* call signature is used for creating a child:
 *    new Logger(<parent logger>, <child options>[, <child opts are simple>]);
 *
 * @param _childSimple (Boolean) An assertion that the given `_childOptions`
 *    (a) only add fields (no config) and (b) no serialization handling is
 *    required for them. IOW, this is a fast path for frequent child
 *    creation.
 */
function Logger(options, _childOptions, _childSimple) {
  xxx('Logger start:', options);
  if (!(this instanceof Logger)) return new Logger(options, _childOptions);

  // Input arg validation.
  let parent;
  if (_childOptions !== undefined) {
    parent = options;
    options = _childOptions;
    if (!(parent instanceof Logger)) {
      throw new TypeError('invalid Logger creation: do not pass a second arg');
    }
  }
  if (!options) throw new TypeError('options (object) is required');
  if (!parent) {
    if (!options.name) throw new TypeError('options.name (string) is required');
  } else {
    if (options.name) throw new TypeError('invalid options.name: child cannot set logger name');
  }
  if (options.stream && options.streams) {
    throw new TypeError('cannot mix "streams" and "stream" options');
  }
  if (options.streams && !Array.isArray(options.streams)) {
    throw new TypeError('invalid options.streams: must be an array');
  }
  if (options.serializers && (typeof options.serializers !== 'object' || Array.isArray(options.serializers))) {
    throw new TypeError('invalid options.serializers: must be an object');
  }

  EventEmitter.call(this);

  // Fast path for simple child creation.
  if (parent && _childSimple) {
    // `_isSimpleChild` is a signal to stream close handling that this child
    // owns none of its streams.
    this._isSimpleChild = true;

    this._level = parent._level;
    this.streams = parent.streams;
    this.serializers = parent.serializers;
    this.src = parent.src;
    let fields = this.fields = {};
    Object.assign(fields, parent.fields, options);

    return;
  }

  // Start values.
  const self = this;
  if (parent) {
    this._level = parent._level;
    this.streams = [];
    for (const i of parent.streams) {
      const s = objCopy(i);
      s.closeOnExit = false; // Don't own parent stream.
      this.streams.push(s);
    }
    this.serializers = objCopy(parent.serializers);
    this.src = parent.src;
    this.fields = objCopy(parent.fields);
    if (options.level) this.level(options.level);
  } else {
    this._level = Number.POSITIVE_INFINITY;
    this.streams = [];
    this.serializers = null;
    this.src = false;
    this.fields = {};
  }

  if (!dtp && dtrace) {
    dtp = dtrace.createDTraceProvider('bunyan');

    for (const level in levelFromName) {
      let probe;

      probes[levelFromName[level]] = probe = dtp.addProbe('log-' + level, 'char *');

      // Explicitly add a reference to dtp to prevent it from being GC'd
      probe.dtp = dtp;
    }

    dtp.enable();
  }

  // Handle *config* options (i.e. options that are not just plain data
  // for log records).
  if (options.stream) {
    self.addStream({
      type: 'stream',
      stream: options.stream,
      closeOnExit: false,
      level: options.level
    });
  } else if (options.streams) {
    options.streams.forEach((s) => {
      self.addStream(s, options.level);
    });
  } else if (parent && options.level) {
    this.level(options.level);
  } else if (!parent) {
    self.addStream({
      type: 'stream',
      stream: process.stdout,
      closeOnExit: false,
      level: options.level
    });
  }
  if (options.serializers) self.addSerializers(options.serializers);
  if (options.src) this.src = true;

  xxx('Logger: ', self);

  // Fields.
  // These are the default fields for log records (minus the attributes
  // removed in this constructor). To allow storing raw log records
  // (unrendered), `this.fields` must never be mutated. Create a copy for
  // any changes.
  const fields = objCopy(options);
  delete fields.stream;
  delete fields.level;
  delete fields.streams;
  delete fields.serializers;
  delete fields.src;
  if (this.serializers) this._applySerializers(fields);

  if (!fields.hostname && !self.fields.hostname) {
    fields.hostname = os.hostname();
  }
  if (!fields.pid) fields.pid = process.pid;

  Object.assign(self.fields, fields);
}

util.inherits(Logger, EventEmitter);

let RotatingFileStream;
if (!RotatingFileStream) RotatingFileStream = null;

if (mv) {
  RotatingFileStream = function(options) {
    this.path = options.path;
    this.count = options.count == null ? 10 : options.count;
    assert.equal(
      typeof this.count,
      'number',
      `rotating-file stream "count" is not a number: ${this.count} (${typeof this.count}) in ${this}`
    );
    assert.ok(
      this.count >= 0,
      `rotating-file stream "count" is not >= 0: ${this.count} in ${this}`
    );

    // Parse `options.period`.
    if (options.period) {
      // <number><scope> where scope is:
      //    h   hours (at the start of the hour)
      //    d   days (at the start of the day, i.e. just after midnight)
      //    w   weeks (at the start of Sunday)
      //    m   months (on the first of the month)
      //    y   years (at the start of Jan 1st)
      // with special values 'hourly' (1h), 'daily' (1d), "weekly" (1w),
      // 'monthly' (1m) and 'yearly' (1y)
      const period = {
        'hourly': '1h',
        'daily': '1d',
        'weekly': '1w',
        'monthly': '1m',
        'yearly': '1y'
      }[options.period] || options.period;
      const m = /^([1-9][0-9]*)([hdwmy]|ms)$/.exec(period);
      if (!m) throw new Error(`invalid period: "${options.period}"`);

      this.periodNum = Number(m[1]);
      this.periodScope = m[2];
    } else {
      this.periodNum = 1;
      this.periodScope = 'd';
    }

    let lastModified = null;
    try {
      const fileInfo = fs.statSync(this.path);
      lastModified = fileInfo.mtime.getTime();
    } catch (err) {
      // file doesn't exist
    }
    let rotateAfterOpen = false;
    if (lastModified) {
      const lastRotTime = this._calcRotTime(0);
      if (lastModified < lastRotTime) {
        rotateAfterOpen = true;
      }
    }

    // TODO: template support for backup files
    // template: <path to which to rotate>
    //      default is %P.%n
    //      '/var/log/archive/foo.log'  -> foo.log.%n
    //      '/var/log/archive/foo.log.%n'
    //      codes:
    //          XXX support strftime codes (per node version of those)
    //              or whatever module. Pick non-colliding for extra
    //              codes
    //          %P      `path` base value
    //          %n      integer number of rotated log (1,2,3,...)
    //          %d      datetime in YYYY-MM-DD_HH-MM-SS
    //                      XXX what should default date format be?
    //                          prior art? Want to avoid ':' in
    //                          filenames (illegal on Windows for one).

    this.stream = fs.createWriteStream(this.path, { flags: 'a', encoding: 'utf8' });

    this.rotQueue = [];
    this.rotating = false;
    if (rotateAfterOpen) {
      this._debug('rotateAfterOpen -> call rotate()');
      this.rotate();
    } else {
      this._setupNextRot();
    }
  };

  util.inherits(RotatingFileStream, EventEmitter);

  RotatingFileStream.prototype._debug = () => {
    // Set this to `true` to add debug logging.
    // eslint-disable-next-line no-constant-condition
    if (false) {
      if (arguments.length === 0) {
        return true;
      }
      let args = Array.prototype.slice.call(arguments);
      args[0] = '[' + new Date().toISOString() + ', '
            + this.path + '] ' + args[0];
      console.log.apply(this, args);
    } else {
      return false;
    }
  };

  RotatingFileStream.prototype._setupNextRot = function() {
    this.rotAt = this._calcRotTime(1);
    this._setRotationTimer();
  };

  RotatingFileStream.prototype._setRotationTimer = function() {
    const self = this;
    let delay = this.rotAt - Date.now();
    // Cap timeout to Node's max setTimeout, see
    // <https://github.com/joyent/node/issues/8656>.
    const TIMEOUT_MAX = 2147483647; // 2^31-1
    if (delay > TIMEOUT_MAX) {
      delay = TIMEOUT_MAX;
    }
    this.timeout = setTimeout(
      () => {
        self._debug('_setRotationTimer timeout -> call rotate()');
        self.rotate();
      },
      delay
    );
    if (typeof this.timeout.unref === 'function') {
      this.timeout.unref();
    }
  };

  RotatingFileStream.prototype._calcRotTime = function _calcRotTime(periodOffset) {
    this._debug(`_calcRotTime: ${this.periodNum}${this.periodScope}`);
    const d = new Date();

    this._debug(`  now local: ${d}`);
    this._debug(`    now utc: ${d.toISOString()}`);
    let rotAt;
    switch (this.periodScope) {
      case 'ms':
      // Hidden millisecond period for debugging.
        if (this.rotAt) {
          rotAt = this.rotAt + (this.periodNum * periodOffset);
        } else {
          rotAt = Date.now() + (this.periodNum * periodOffset);
        }
        break;
      case 'h':
        if (this.rotAt) {
          rotAt = this.rotAt + (this.periodNum * 60 * 60 * 1000 * periodOffset);
        } else {
        // First time: top of the next hour.
          rotAt = Date.UTC(
            d.getUTCFullYear(),
            d.getUTCMonth(),
            d.getUTCDate(),
            d.getUTCHours() + periodOffset
          );
        }
        break;
      case 'd':
        if (this.rotAt) {
          rotAt = this.rotAt + (this.periodNum * 24 * 60 * 60 * 1000 * periodOffset);
        } else {
        // First time: start of tomorrow (i.e. at the coming midnight) UTC.
          rotAt = Date.UTC(
            d.getUTCFullYear(),
            d.getUTCMonth(),
            d.getUTCDate() + periodOffset
          );
        }
        break;
      case 'w':
      // Currently, always on Sunday morning at 00:00:00 (UTC).
        if (this.rotAt) {
          rotAt = this.rotAt + (this.periodNum * 7 * 24 * 60 * 60 * 1000 * periodOffset);
        } else {
        // First time: this coming Sunday.
          let dayOffset = 7 - d.getUTCDay();
          if (periodOffset < 1) {
            dayOffset = -d.getUTCDay();
          }
          if (periodOffset > 1 || periodOffset < -1) {
            dayOffset += 7 * periodOffset;
          }
          rotAt = Date.UTC(
            d.getUTCFullYear(),
            d.getUTCMonth(),
            d.getUTCDate() + dayOffset
          );
        }
        break;
      case 'm':
        if (this.rotAt) {
          rotAt = Date.UTC(
            d.getUTCFullYear(),
            d.getUTCMonth() + (this.periodNum * periodOffset),
            1
          );
        } else {
        // First time: the start of the next month.
          rotAt = Date.UTC(
            d.getUTCFullYear(),
            d.getUTCMonth() + periodOffset,
            1
          );
        }
        break;
      case 'y':
        if (this.rotAt) {
          rotAt = Date.UTC(
            d.getUTCFullYear() + (this.periodNum * periodOffset),
            0,
            1
          );
        } else {
        // First time: the start of the next year.
          rotAt = Date.UTC(
            d.getUTCFullYear() + periodOffset,
            0,
            1
          );
        }
        break;
      default:
        assert.fail(`invalid period scope: "${this.periodScope}"`);
    }

    if (this._debug()) {
      this._debug(`  **rotAt**: ${rotAt} (utc: ${new Date(rotAt).toUTCString()})`);
      const now = Date.now();
      this._debug(`        now: ${now} (${rotAt - now}ms == ${(rotAt - now) / 1000 / 60}min == ${(rotAt - now) / 1000 / 60 / 60}h to go)`);
    }
    return rotAt;
  };

  RotatingFileStream.prototype.rotate = function rotate() {
    // XXX What about shutdown?
    const self = this;

    // If rotation period is > ~25 days, we have to break into multiple
    // setTimeout's. See <https://github.com/joyent/node/issues/8656>.
    if (self.rotAt && self.rotAt > Date.now()) return self._setRotationTimer();

    this._debug('rotate');
    if (self.rotating) {
      throw new TypeError('cannot start a rotation when already rotating');
    }
    self.rotating = true;

    self.stream.end(); // XXX can do moves sync after this? test at high rate

    function del(n) {
      let toDel = self.path + '.' + String(n - 1);
      if (n === 0) {
        toDel = self.path;
      }
      n -= 1;
      self._debug(`  rm ${toDel}`);
      fs.unlink(toDel, (delErr) => {
        // XXX handle err other than not exists
        moves(n);
      });
    }

    function moves(n) {
      if (self.count === 0 || n < 0) {
        return finish();
      }
      let before = self.path;
      const after = self.path + '.' + String(n);
      if (n > 0) {
        before += '.' + String(n - 1);
      }
      n -= 1;

      fs.access(before, fs.constants.F_OK, err => {
        if (err) {
          moves(n);
        } else {
          self._debug(`  mv ${before} ${after}`);
          mv(before, after, (mvErr) => {
            if (mvErr) {
              self.emit('error', mvErr);
              finish(); // XXX finish here?
            } else {
              moves(n);
            }
          });
        }
      });
    }

    function finish() {
      self._debug(`  open ${self.path}`);
      self.stream = fs.createWriteStream(self.path, { flags: 'a', encoding: 'utf8' });

      for (const q of self.rotQueue) {
        self.stream.write(q);
      }
      self.rotQueue = [];
      self.rotating = false;
      self.emit('drain');
      self._setupNextRot();
    }

    let n = this.count;
    del(n);
  };

  RotatingFileStream.prototype.write = function(s) {
    if (this.rotating) {
      this.rotQueue.push(s);
      return false;
    }
    return this.stream.write(s);
  };

  RotatingFileStream.prototype.end = function(s) {
    this.stream.end();
  };

  RotatingFileStream.prototype.destroy = function destroy(s) {
    this.stream.destroy();
  };

  RotatingFileStream.prototype.destroySoon = function destroySoon(s) {
    this.stream.destroySoon();
  };

} /* if (mv) */

/**
 * Add a stream
 *
 * @param stream {Object}. Object with these fields:
 *    - `type`: The stream type. See README.md for full details.
 *      Often this is implied by the other fields. Examples are
 *      'file', 'stream' and "raw".
 *    - `path` or `stream`: The specify the file path or writeable
 *      stream to which log records are written. E.g.
 *      `stream: process.stdout`.
 *    - `level`: Optional. Falls back to `defaultLevel`.
 *    - `closeOnExit` (boolean): Optional. Default is true for a
 *      'file' stream when `path` is given, false otherwise.
 *    See README.md for full details.
 * @param defaultLevel {Number|String} Optional. A level to use if
 *      `stream.level` is not set. If neither is given, this defaults to INFO.
 */
Logger.prototype.addStream = function addStream(s, defaultLevel) {
  const self = this;
  if (defaultLevel === null || defaultLevel === undefined) {
    defaultLevel = INFO;
  }

  s = objCopy(s);

  // Implicit 'type' from other args.
  if (!s.type) {
    if (s.stream) {
      s.type = 'stream';
    } else if (s.path) {
      s.type = 'file';
    }
  }
  s.raw = s.type === 'raw'; // PERF: Allow for faster check in `_emit`.

  if (s.level !== undefined) {
    s.level = resolveLevel(s.level);
  } else {
    s.level = resolveLevel(defaultLevel);
  }
  if (s.level < self._level) self._level = s.level;

  switch (s.type) {
    case 'stream':
      assert.ok(isWritable(s.stream), '"stream" stream is not writable: ' + util.inspect(s.stream));

      if (!s.closeOnExit) s.closeOnExit = false;
      break;
    case 'file':
      if (s.reemitErrorEvents === undefined) s.reemitErrorEvents = true;

      if (!s.stream) {
        s.stream = fs.createWriteStream(s.path, {flags: 'a', encoding: 'utf8'});
        if (!s.closeOnExit) s.closeOnExit = true;
      } else {
        if (!s.closeOnExit) s.closeOnExit = false;
      }
      break;
    case 'rotating-file':
      assert.ok(!s.stream, '"rotating-file" stream should not give a "stream"');
      assert.ok(s.path);
      assert.ok(mv, '"rotating-file" stream type is not supported: missing "mv" module');
      s.stream = new RotatingFileStream(s);
      if (!s.closeOnExit) s.closeOnExit = true;
      break;
    case 'raw':
      if (!s.closeOnExit) s.closeOnExit = false;
      break;
    default:
      throw new TypeError(`unknown stream type "${s.type}"`);
  }

  if (s.reemitErrorEvents && typeof s.stream.on === 'function') {
    // TODO: When we have `<logger>.close()`, it should remove event
    //      listeners to not leak Logger instances.
    s.stream.on('error', (err) => {
      self.emit('error', err, s);
    });
  }

  self.streams.push(s);
  delete self.haveNonRawStreams; // reset
};


/**
 * Add serializers
 *
 * @param serializers {Object} Optional. Object mapping log record field names
 *    to serializing functions. See README.md for details.
 */
Logger.prototype.addSerializers = function addSerializers(serializers) {
  const self = this;

  if (!self.serializers) self.serializers = {};

  Object.keys(serializers).forEach((field) => {
    const serializer = serializers[field];
    if (typeof serializer !== 'function') {
      throw new TypeError(`invalid serializer for "${field}" field: must be a function`);
    } else {
      self.serializers[field] = serializer;
    }
  });
};

/**
 * Create a child logger, typically to add a few log record fields.
 *
 * This can be useful when passing a logger to a sub-component, e.g. a
 * 'wuzzle' component of your service:
 *
 *    var wuzzleLog = log.child({component: 'wuzzle'})
 *    var wuzzle = new Wuzzle({..., log: wuzzleLog})
 *
 * Then log records from the wuzzle code will have the same structure as
 * the app log, *plus the component='wuzzle' field*.
 *
 * @param options {Object} Optional. Set of options to apply to the child.
 *    All of the same options for a new Logger apply here. Notes:
 *      - The parent's streams are inherited and cannot be removed in this
 *        call. Any given `streams` are *added* to the set inherited from
 *        the parent.
 *      - The parent's serializers are inherited, though can effectively be
 *        overwritten by using duplicate keys.
 *      - Can use `level` to set the level of the streams inherited from
 *        the parent. The level for the parent is NOT affected.
 * @param simple {Boolean} Optional. Set to true to assert that `options`
 *    (a) only add fields (no config) and (b) no serialization handling is
 *    required for them. IOW, this is a fast path for frequent child
 *    creation. See 'tools/timechild.js' for numbers.
 */
Logger.prototype.child = function(options, simple) {
  return new this.constructor(this, options || {}, simple);
};


/**
 * A convenience method to reopen 'file' streams on a logger. This can be
 * useful with external log rotation utilities that move and re-open log files
 * (e.g. logrotate on Linux, logadm on SmartOS/Illumos). Those utilities
 * typically have rotation options to copy-and-truncate the log file, but
 * you may not want to use that. An alternative is to do this in your
 * application:
 *
 *      var log = bunyan.createLogger(...);
 *      ...
 *      process.on('SIGUSR2', function () {
 *          log.reopenFileStreams();
 *      });
 *      ...
 *
 * See <https://github.com/trentm/node-bunyan/issues/104>.
 */
Logger.prototype.reopenFileStreams = function() {
  const self = this;
  self.streams.forEach((s) => {
    if (s.type === 'file') {
      if (s.stream) {
        // Not sure if typically would want this, or more immediate
        // `s.stream.destroy()`.
        s.stream.end();
        s.stream.destroySoon();
        delete s.stream;
      }
      s.stream = fs.createWriteStream(s.path, { flags: 'a', encoding: 'utf8' });
      s.stream.on('error', (err) => {
        self.emit('error', err, s);
      });
    }
  });
};


/* BEGIN JSSTYLED */
/**
 * Close this logger.
 *
 * This closes streams (that it owns, as per 'endOnClose' attributes on
 * streams), etc. Typically you **don't** need to bother calling this.
Logger.prototype.close = function () {
    if (this._closed) {
        return;
    }
    if (!this._isSimpleChild) {
        self.streams.forEach(function (s) {
            if (s.endOnClose) {
                xxx('closing stream s:', s);
                s.stream.end();
                s.endOnClose = false;
            }
        });
    }
    this._closed = true;
}
 */
/* END JSSTYLED */


/**
 * Get/set the level of all streams on this logger.
 *
 * Get Usage:
 *    // Returns the current log level (lowest level of all its streams).
 *    log.level() -> INFO
 *
 * Set Usage:
 *    log.level(INFO)       // set all streams to level INFO
 *    log.level('info')     // can use 'info' et al aliases
 */
Logger.prototype.level = function level(value) {
  if (value === undefined) return this._level;

  const newLevel = resolveLevel(value);
  for (const i of this.streams) {
    i.level = newLevel;
  }
  this._level = newLevel;
};


/**
 * Get/set the level of a particular stream on this logger.
 *
 * Get Usage:
 *    // Returns an array of the levels of each stream.
 *    log.levels() -> [TRACE, INFO]
 *
 *    // Returns a level of the identified stream.
 *    log.levels(0) -> TRACE      // level of stream at index 0
 *    log.levels('foo')           // level of stream with name 'foo'
 *
 * Set Usage:
 *    log.levels(0, INFO)         // set level of stream 0 to INFO
 *    log.levels(0, 'info')       // can use 'info' et al aliases
 *    log.levels('foo', WARN)     // set stream named 'foo' to WARN
 *
 * Stream names: When streams are defined, they can optionally be given
 * a name. For example,
 *       log = new Logger({
 *         streams: [
 *           {
 *             name: 'foo',
 *             path: '/var/log/my-service/foo.log'
 *             level: 'trace'
 *           },
 *         ...
 *
 * @param name {String|Number} The stream index or name.
 * @param value {Number|String} The level value (INFO) or alias ('info').
 *    If not given, this is a 'get' operation.
 * @throws {Error} If there is no stream with the given name.
 */
Logger.prototype.levels = function levels(name, value) {
  if (name === undefined) {
    assert.equal(value, undefined);
    return this.streams.map((s) => s.level);
  }
  let stream;
  if (typeof name === 'number') {
    stream = this.streams[name];
    if (stream === undefined) throw new Error('invalid stream index: ' + name);
  } else {
    for (const s of this.streams) {
      if (s.name === name) {
        stream = s;
        break;
      }
    }
    if (!stream) throw new Error(`no stream with name "${name}"`);
  }
  if (value === undefined) return stream.level;

  const newLevel = resolveLevel(value);
  stream.level = newLevel;
  if (newLevel < this._level) this._level = newLevel;

};


/**
 * Apply registered serializers to the appropriate keys in the given fields.
 *
 * Pre-condition: This is only called if there is at least one serializer.
 *
 * @param fields (Object) The log record fields.
 * @param excludeFields (Object) Optional mapping of keys to `true` for
 *    keys to NOT apply a serializer.
 */
Logger.prototype._applySerializers = function(fields, excludeFields) {
  const self = this;

  xxx('_applySerializers: excludeFields', excludeFields);

  // Check each serializer against these (presuming number of serializers
  // is typically less than number of fields).
  Object.keys(this.serializers).forEach((name) => {
    if (fields[name] === undefined || (excludeFields && excludeFields[name])) return;

    xxx('_applySerializers; apply to "%s" key', name);
    try {
      fields[name] = self.serializers[name](fields[name]);
    } catch (err) {
      _warn(`bunyan: ERROR: Exception thrown from the "${name}" Bunyan serializer. This should never happen. This is a bug in that serializer function.\n${err.stack || err}`);

      fields[name] = `(Error in Bunyan log "${name}" serializer broke field. See stderr for details.)`;
    }
  });
};


/**
 * Emit a log record.
 *
 * @param rec {log record}
 * @param noemit {Boolean} Optional. Set to true to skip emission
 *      and just return the JSON string.
 */
Logger.prototype._emit = function(rec, noemit) {
  // Lazily determine if this Logger has non-'raw' streams. If there are
  // any, then we need to stringify the log record.
  if (this.haveNonRawStreams === undefined) {
    this.haveNonRawStreams = false;
    for (const s of this.streams) {
      if (!s.raw) {
        this.haveNonRawStreams = true;
        break;
      }
    }
  }

  // Stringify the object (creates a warning str on error).
  let str;
  if (noemit || this.haveNonRawStreams) {
    str = fastAndSafeJsonStringify(rec) + '\n';
  }

  if (noemit) return str;

  const level = rec.level;
  for (const s of this.streams) {
    if (s.level <= level) {
      xxx('writing log rec "%s" to "%s" stream (%d <= %d): %j', rec.msg, s.type, s.level, level, rec);
      s.stream.write(s.raw ? rec : str);
    }
  }
  return str;
};


/**
 * Build a record object suitable for emitting from the arguments
 * provided to the a log emitter.
 */
function mkRecord(log, minLevel, args) {
  let excludeFields, fields, msgArgs;
  if (args[0] instanceof Error) {
    // `log.<level>(err, ...)`
    fields = {
      // Use this Logger's err serializer, if defined.
      err: log.serializers && log.serializers.err
        ? log.serializers.err(args[0])
        : Logger.stdSerializers.err(args[0])
    };
    excludeFields = { err: true };
    msgArgs = args.length === 1 ? [fields.err.message] : args.slice(1);
  } else if (typeof args[0] !== 'object' || Array.isArray(args[0])) {
    // `log.<level>(msg, ...)`
    fields = null;
    msgArgs = args.slice();
  } else if (Buffer.isBuffer(args[0])) { // `log.<level>(buf, ...)`
    // Almost certainly an error, show `inspect(buf)`. See bunyan
    // issue #35.
    fields = null;
    msgArgs = args.slice();
    msgArgs[0] = util.inspect(msgArgs[0]);
  } else { // `log.<level>(fields, msg, ...)`
    fields = args[0];
    if (fields && args.length === 1 && fields.err && fields.err instanceof Error) {
      msgArgs = [fields.err.message];
    } else {
      msgArgs = args.slice(1);
    }
  }

  // Build up the record object.
  const rec = objCopy(log.fields);
  rec.level = minLevel;
  const recFields = fields ? objCopy(fields) : null;
  if (recFields) {
    if (log.serializers) log._applySerializers(recFields, excludeFields);

    Object.assign(rec, recFields);
  }

  rec.msg = format.apply(log, msgArgs);
  if (!rec.time) rec.time = new Date();

  // Get call source info
  if (log.src && !rec.src) rec.src = getCaller3Info();

  rec.v = LOG_VERSION;

  return rec;
}


/**
 * Build an array that dtrace-provider can use to fire a USDT probe. If we've
 * already built the appropriate string, we use it. Otherwise, build the
 * record object and stringify it.
 */
function mkProbeArgs(str, log, minLevel, msgArgs) {
  return [str || log._emit(mkRecord(log, minLevel, msgArgs), true)];
}


/**
 * Build a log emitter function for level minLevel. I.e. this is the
 * creator of `log.info`, `log.error`, etc.
 */
function mkLogEmitter(minLevel) {
  return function() {
    const log = this;
    let str = null;
    let rec = null;

    if (!this._emit) {

      /*
       * Show this invalid Bunyan usage warning *once*.
       *
       * See <https://github.com/trentm/node-bunyan/issues/100> for
       * an example of how this can happen.
       */
      const dedupKey = 'unbound';
      if (!_haveWarned[dedupKey]) {
        const caller = getCaller3Info();
        _warn(`bunyan usage error: ${caller.file}:${caller.line}: attempt to log with an unbound log method: \`this\` is: ${util.inspect(this)}`, dedupKey);
      }
      return;
    } else if (arguments.length === 0) { // `log.<level>()`
      return this._level <= minLevel;
    }

    const msgArgs = Object.values(arguments);

    if (this._level <= minLevel) {
      rec = mkRecord(log, minLevel, msgArgs);
      str = this._emit(rec);
    }

    if (probes) probes[minLevel].fire(mkProbeArgs, str, log, minLevel, msgArgs);
  };
}


/**
 * The functions below log a record at a specific level.
 *
 * Usages:
 *    log.<level>()  -> boolean is-trace-enabled
 *    log.<level>(<Error> err, [<string> msg, ...])
 *    log.<level>(<string> msg, ...)
 *    log.<level>(<object> fields, <string> msg, ...)
 *
 * where <level> is the lowercase version of the log level. E.g.:
 *
 *    log.info()
 *
 * @params fields {Object} Optional set of additional fields to log.
 * @params msg {String} Log message. This can be followed by additional
 *    arguments that are handled like
 *    [util.format](http://nodejs.org/docs/latest/api/all.html#util.format).
 */
Logger.prototype.trace = mkLogEmitter(TRACE);
Logger.prototype.debug = mkLogEmitter(DEBUG);
Logger.prototype.info = mkLogEmitter(INFO);
Logger.prototype.warn = mkLogEmitter(WARN);
Logger.prototype.error = mkLogEmitter(ERROR);
Logger.prototype.fatal = mkLogEmitter(FATAL);

// ---- Standard serializers
// A serializer is a function that serializes a JavaScript object to a
// JSON representation for logging. There is a standard set of presumed
// interesting objects in node.js-land.

Logger.stdSerializers = {};

// Serialize an HTTP request.
Logger.stdSerializers.req = (req) => {
  if (!req || !req.connection) return req;
  return {
    method: req.method,
    url: req.url,
    headers: req.headers,
    remoteAddress: req.connection.remoteAddress,
    remotePort: req.connection.remotePort
  };
  // Trailers: Skipping for speed. If you need trailers in your app, then
  // make a custom serializer.
  // if (Object.keys(trailers).length > 0) {
  //  obj.trailers = req.trailers;
  // }
};

// Serialize an HTTP response.
Logger.stdSerializers.res = (res) => {
  if (!res || !res.statusCode) return res;
  return {
    statusCode: res.statusCode,
    header: res._header
  };
};


/*
 * This function dumps long stack traces for exceptions having a cause()
 * method. The error classes from
 * [verror](https://github.com/davepacheco/node-verror) and
 * [restify v2.0](https://github.com/mcavage/node-restify) are examples.
 *
 * Based on `dumpException` in
 * https://github.com/davepacheco/node-extsprintf/blob/master/lib/extsprintf.js
 */
function getFullErrorStack(ex) {
  let ret = ex.stack || ex.toString();
  if (ex.cause && typeof ex.cause === 'function') {
    const cex = ex.cause();
    if (cex) ret += '\nCaused by: ' + getFullErrorStack(cex);
  }
  return ret;
}

// Serialize an Error object
// (Core error properties are enumerable in node 0.4, not in 0.6).
Logger.stdSerializers.err = (err) => {
  if (!err || !err.stack) return err;
  return {
    message: err.message,
    name: err.name,
    stack: getFullErrorStack(err),
    code: err.code,
    signal: err.signal
  };
};


// A JSON stringifier that handles cycles safely - tracks seen values in a Set.
function safeCyclesSet() {
  const seen = new Set();
  return (key, val) => {
    if (!val || typeof val !== 'object') return val;
    if (seen.has(val)) return '[Circular]';
    seen.add(val);
    return val;
  };
}

/**
 * A JSON stringifier that handles cycles safely - tracks seen vals in an Array.
 *
 * Note: This approach has performance problems when dealing with large objects,
 * see trentm/node-bunyan#445, but since this is the only option for node 0.10
 * and earlier (as Set was introduced in Node 0.12), it's used as a fallback
 * when Set is not available.
 */
function safeCyclesArray() {
  let seen = [];
  return (key, val) => {
    if (!val || typeof val !== 'object') return val;
    if (seen.indexOf(val) !== -1) return '[Circular]';
    seen.push(val);
    return val;
  };
}

/**
 * A JSON stringifier that handles cycles safely.
 *
 * Usage: JSON.stringify(obj, safeCycles())
 *
 * Choose the best safe cycle function from what is available - see
 * trentm/node-bunyan#445.
 */
const safeCycles = typeof Set !== 'undefined' ? safeCyclesSet : safeCyclesArray;

/**
 * A fast JSON.stringify that handles cycles and getter exceptions (when
 * safeJsonStringify is installed).
 *
 * This function attempts to use the regular JSON.stringify for speed, but on
 * error (e.g. JSON cycle detection exception) it falls back to safe stringify
 * handlers that can deal with cycles and/or getter exceptions.
 */
function fastAndSafeJsonStringify(rec) {
  try {
    return JSON.stringify(rec);
  } catch (ex) {
    try {
      return JSON.stringify(rec, safeCycles());
    } catch (e) {
      if (safeJsonStringify) return safeJsonStringify(rec);

      const dedupKey = e.stack.split(/\n/g, 3).join('\n');
      _warn(
        'bunyan: ERROR: Exception in '
          + '`JSON.stringify(rec)`. You can install the '
          + '"safe-json-stringify" module to have Bunyan fallback '
          + 'to safer stringification. Record:\n'
          + _indent(`${util.inspect(rec)}\n${e.stack}`),
        dedupKey
      );
      return `(Exception in JSON.stringify(rec): ${e.message}. See stderr for details.)`;

    }
  }
}

/**
 * RingBuffer is a Writable Stream that just stores the last N records in
 * memory.
 *
 * @param options {Object}, with the following fields:
 *
 *    - limit: number of records to keep in memory
 */
function RingBuffer(options) {
  this.limit = options && options.limit ? options.limit : 100;
  this.writable = true;
  this.records = [];
  EventEmitter.call(this);
}

util.inherits(RingBuffer, EventEmitter);

RingBuffer.prototype.write = function(record) {
  if (!this.writable) throw new Error('RingBuffer has been ended already');

  this.records.push(record);

  if (this.records.length > this.limit) this.records.shift();

  return true;
};

RingBuffer.prototype.end = function() {
  if (arguments.length > 0) this.write.apply(this, Array.prototype.slice.call(arguments));
  this.writable = false;
};

RingBuffer.prototype.destroy = function() {
  this.writable = false;
  this.emit('close');
};

RingBuffer.prototype.destroySoon = function() {
  this.destroy();
};


// ---- Exports

module.exports = Logger;

module.exports.TRACE = TRACE;
module.exports.DEBUG = DEBUG;
module.exports.INFO = INFO;
module.exports.WARN = WARN;
module.exports.ERROR = ERROR;
module.exports.FATAL = FATAL;
module.exports.resolveLevel = resolveLevel;
module.exports.levelFromName = levelFromName;
module.exports.nameFromLevel = nameFromLevel;

module.exports.VERSION = VERSION;
module.exports.LOG_VERSION = LOG_VERSION;

module.exports.createLogger = function(options) {
  return new Logger(options);
};

module.exports.RingBuffer = RingBuffer;
module.exports.RotatingFileStream = RotatingFileStream;

// Useful for custom `type == 'raw'` streams that may do JSON stringification
// of log records themselves. Usage:
//    var str = JSON.stringify(rec, bunyan.safeCycles());
module.exports.safeCycles = safeCycles;
