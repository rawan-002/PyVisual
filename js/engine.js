/*
 * Visual Python engine (runs inside Pyodide)
 * ------------------------------------------
 *  1) Traces any Python program line by line (sys.settrace) and takes a
 *     snapshot of memory at each step: frames and objects.
 *  2) Builds a flowchart from the code using ast.
 *  3) Supports turtle (drawn on a canvas) and matplotlib (PNG figures).
 */
window.PY_ENGINE = String.raw`
import sys, math, json, types, builtins, io, base64, os, warnings, inspect, ast

os.environ.setdefault('MPLBACKEND', 'Agg')
warnings.filterwarnings('ignore', message='.*non-interactive.*')
warnings.filterwarnings('ignore', message='.*FigureCanvasAgg.*')

_FILE = '<code>'
_W = 400
_H = 400
_MAX_REC = 1500        # max recorded steps
_MAX_EVENTS = 300000   # infinite-loop guard
_MAX_CMDS = 20000      # drawing-command guard
_MAX_OBJ = 120         # max objects per snapshot
_LIM = 30              # max items shown per container


class _TooLong(BaseException):
    pass


class _TooMany(BaseException):
    pass


_S = {}
_DEF = [None]

# Every program runs inside this folder of the browser's virtual disk.
# Files written there stay until the page is reloaded (or "Reset disk").
_DISK = '/home/pyodide/files'
_SEED = {'data.txt': 'hello\nI am\na student\n\nPython is fun\n12345\n'}


def _seed_disk():
    os.makedirs(_DISK, exist_ok=True)
    for k, v in _SEED.items():
        if not os.path.exists(os.path.join(_DISK, k)):
            with open(os.path.join(_DISK, k), 'w', encoding='utf-8') as f:
                f.write(v)


def _clear_disk():
    import shutil
    if os.path.isdir(_DISK):
        shutil.rmtree(_DISK)
    _seed_disk()
    os.chdir(_DISK)
    return 'ok'


_seed_disk()
os.chdir(_DISK)


def _reset():
    for v in _S.get('keep', []):
        if isinstance(v, io.IOBase) and not isinstance(v, (io.StringIO, io.BytesIO)):
            try:
                v.close()
            except Exception:
                pass
    try:
        os.chdir(_DISK)
    except Exception:
        _seed_disk()
        os.chdir(_DISK)
    _S['disks'] = []
    _S['dkmap'] = {}
    _S['comp'] = {}        # comprehension rounds waiting to be attached to the next step
    _S['exc'] = None       # exception raised since the last step
    _S['exf'] = None       # frame where the latest exception happened
    _S['inp'] = []         # input() calls since the last step
    _S['stdin'] = _S.get('stdin_next', [])
    _S['stdin_pos'] = 0
    _S['dcache'] = {}
    _S['cmds'] = []
    _S['out'] = []
    _S['steps'] = []
    _S['events'] = 0
    _S['truncated'] = False
    _S['tid'] = 0
    _S['last'] = 1
    _S['ids'] = {}
    _S['keep'] = []
    _S['fids'] = {}
    _DEF[0] = None


_reset()


def _col(c):
    if isinstance(c, (tuple, list)) and len(c) == 3:
        vals = [_n(v) for v in c]
        if all(v <= 1 for v in vals):
            vals = [v * 255 for v in vals]
        return 'rgb(%d,%d,%d)' % tuple(int(v) for v in vals)
    if not isinstance(c, str):
        raise TypeError('color must be a string like "red", not %r' % (c,))
    return c.strip()


def _cname(c):
    return c if isinstance(c, str) else str(c)


def _n(v):
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        raise TypeError('%r is not a number' % (v,))
    v = float(v)
    if not math.isfinite(v):
        raise ValueError('invalid number')
    return v


def _f(v):
    v = float(v)
    if v == int(v):
        return str(int(v))
    return '%.1f' % v


def _uline():
    f = sys._getframe(1)
    while f is not None and f.f_code.co_filename != _FILE:
        f = f.f_back
    return f.f_lineno if f is not None else 0


def _add(kind, desc, **kw):
    if len(_S['cmds']) >= _MAX_CMDS:
        raise _TooMany()
    kw['type'] = kind
    kw['desc'] = desc
    kw['line'] = _uline()
    _S['cmds'].append(kw)


# ------------------------------------------------------------------
# turtle — same coordinates as real turtle: (0, 0) is the center, y points up
# ------------------------------------------------------------------

def _c(x, y):
    return [_W / 2 + x, _H / 2 - y]


class Turtle:
    def __init__(self, *a, **k):
        _S['tid'] += 1
        self._id = _S['tid']
        self._x = 0.0
        self._y = 0.0
        self._h = 0.0
        self._down = True
        self._pc = 'black'
        self._fc = 'black'
        self._w = 2
        self._fill = None
        self._vis = True
        self._emit('tstate', 'Created a new turtle at the center (0, 0)')

    def __repr__(self):
        return 'Turtle(x=%s, y=%s, heading=%s)' % (_f(self._x), _f(self._y), _f(self._h))

    def _emit(self, kind, desc, **kw):
        p = _c(self._x, self._y)
        kw.update(tid=self._id, tx=p[0], ty=p[1], th=self._h, tv=self._vis, tc=_col(self._pc))
        _add(kind, desc, **kw)

    def _go(self, nx, ny, desc_draw, desc_move):
        p0 = _c(self._x, self._y)
        self._x, self._y = nx, ny
        p1 = _c(nx, ny)
        if self._fill is not None:
            self._fill.append(p1)
        if self._down:
            self._emit('line', desc_draw, x1=p0[0], y1=p0[1], x2=p1[0], y2=p1[1], color=_col(self._pc), width=self._w)
        else:
            self._emit('tstate', desc_move)

    def forward(self, distance):
        d = _n(distance)
        a = math.radians(self._h)
        self._go(self._x + d * math.cos(a), self._y + d * math.sin(a),
                 'Turtle moved forward %s, drawing a line' % _f(d), 'Turtle moved forward %s without drawing' % _f(d))
    fd = forward

    def backward(self, distance):
        d = _n(distance)
        a = math.radians(self._h)
        self._go(self._x - d * math.cos(a), self._y - d * math.sin(a),
                 'Turtle moved back %s, drawing a line' % _f(d), 'Turtle moved back %s without drawing' % _f(d))
    bk = backward
    back = backward

    def left(self, angle):
        a = _n(angle)
        self._h = (self._h + a) % 360
        self._emit('tstate', 'Turtle turned left %s° (now facing %s°)' % (_f(a), _f(self._h)))
    lt = left

    def right(self, angle):
        a = _n(angle)
        self._h = (self._h - a) % 360
        self._emit('tstate', 'Turtle turned right %s° (now facing %s°)' % (_f(a), _f(self._h)))
    rt = right

    def setheading(self, angle):
        self._h = _n(angle) % 360
        self._emit('tstate', 'Turtle now faces %s°' % _f(self._h))
    seth = setheading

    def goto(self, x, y=None):
        if y is None:
            x, y = x
        x, y = _n(x), _n(y)
        self._go(x, y, 'Turtle went to (%s, %s), drawing a line' % (_f(x), _f(y)),
                 'Turtle moved to (%s, %s) without drawing' % (_f(x), _f(y)))
    setpos = goto
    setposition = goto

    def home(self):
        self._h = 0.0
        self.goto(0, 0)

    def penup(self):
        self._down = False
        self._emit('tstate', 'Pen up')
    pu = penup
    up = penup

    def pendown(self):
        self._down = True
        self._emit('tstate', 'Pen down')
    pd = pendown
    down = pendown

    def isdown(self):
        return self._down

    def pencolor(self, c):
        _col(c)
        self._pc = c
        self._emit('tstate', 'Pen color is now %s' % _cname(c))

    def fillcolor(self, c):
        _col(c)
        self._fc = c
        self._emit('tstate', 'Fill color is now %s' % _cname(c))

    def color(self, pen, fill=None):
        _col(pen)
        self._pc = pen
        self._fc = fill if fill is not None else pen
        self._emit('tstate', 'Turtle color is now %s' % _cname(pen))

    def width(self, w):
        self._w = abs(_n(w))
        self._emit('tstate', 'Pen width is now %s' % _f(self._w))
    pensize = width

    def begin_fill(self):
        self._fill = [_c(self._x, self._y)]
        self._emit('tstate', 'Started filling')

    def end_fill(self):
        pts = self._fill or []
        self._fill = None
        if len(pts) >= 3:
            self._emit('polygon', 'Filled the shape with %s' % _cname(self._fc), pts=pts, color=_col(self._fc),
                       stroke=_col(self._pc) if self._down else None, width=self._w)

    def circle(self, radius, extent=360, steps=None):
        r = _n(radius)
        ext = _n(extent)
        if steps is None:
            frac = abs(ext) / 360
            steps = 1 + int(min(11 + abs(r) / 6.0, 59.0) * frac)
        n = max(1, int(steps))
        w = ext / n
        w2 = w / 2
        ln = 2.0 * r * math.sin(math.radians(w2))
        if r < 0:
            ln, w, w2 = -ln, -w, -w2
        pts = [_c(self._x, self._y)]
        self._h += w2
        for _i in range(n):
            a = math.radians(self._h)
            self._x += ln * math.cos(a)
            self._y += ln * math.sin(a)
            pts.append(_c(self._x, self._y))
            if self._fill is not None:
                self._fill.append(pts[-1])
            self._h += w
        self._h = (self._h - w2) % 360
        desc = 'Turtle drew a circle with radius %s' % _f(abs(r))
        if self._down:
            self._emit('poly', desc, pts=pts, color=_col(self._pc), width=self._w)
        else:
            self._emit('tstate', 'Turtle moved along a circle without drawing')

    def dot(self, size=None, color=None):
        if size is None:
            size = max(self._w + 4, self._w * 2)
        c = color if color is not None else self._pc
        p = _c(self._x, self._y)
        self._emit('circle', 'Turtle drew a dot', x=p[0], y=p[1], r=abs(_n(size)) / 2, color=_col(c))

    def write(self, arg, move=False, align='left', font=('Arial', 14, 'normal')):
        size = 16
        try:
            size = max(10, float(font[1]) * 1.4)
        except Exception:
            pass
        p = _c(self._x, self._y)
        self._emit('text', 'Turtle wrote "%s"' % arg, x=p[0], y=p[1] - size / 2, msg=str(arg),
                   color=_col(self._pc), size=size)

    def hideturtle(self):
        self._vis = False
        self._emit('tstate', 'Turtle hidden')
    ht = hideturtle

    def showturtle(self):
        self._vis = True
        self._emit('tstate', 'Turtle shown')
    st = showturtle

    def position(self):
        return (self._x, self._y)
    pos = position

    def xcor(self):
        return self._x

    def ycor(self):
        return self._y

    def heading(self):
        return self._h

    def speed(self, *a, **k):
        pass

    def shape(self, *a, **k):
        pass


def _bg(c):
    _add('bg', 'Background set to %s' % _cname(c), color=_col(c))


def _dt():
    if _DEF[0] is None:
        _DEF[0] = Turtle()
    return _DEF[0]


class _Screen:
    def bgcolor(self, c):
        _bg(c)

    def __getattr__(self, name):
        return lambda *a, **k: None


_tmod = types.ModuleType('turtle')
_tmod.Turtle = Turtle
_tmod.Pen = Turtle
_tmod.Screen = lambda: _Screen()
_tmod.bgcolor = lambda c: _bg(c)
for _nm in ['done', 'mainloop', 'exitonclick', 'tracer', 'update', 'setup', 'title', 'colormode']:
    setattr(_tmod, _nm, lambda *a, **k: None)


def _mk(name):
    def f(*a, **k):
        return getattr(_dt(), name)(*a, **k)
    f.__name__ = name
    return f


for _nm in ['forward', 'fd', 'backward', 'bk', 'back', 'left', 'lt', 'right', 'rt', 'goto', 'setpos',
            'setposition', 'setheading', 'seth', 'home', 'penup', 'pu', 'up', 'pendown', 'pd', 'down',
            'isdown', 'pencolor', 'fillcolor', 'color', 'width', 'pensize', 'begin_fill', 'end_fill',
            'circle', 'dot', 'write', 'hideturtle', 'ht', 'showturtle', 'st', 'position', 'pos',
            'xcor', 'ycor', 'heading', 'speed', 'shape']:
    setattr(_tmod, _nm, _mk(_nm))

sys.modules['turtle'] = _tmod


# ------------------------------------------------------------------
# Memory snapshot: frames and objects
# ------------------------------------------------------------------

_PRIM = (type(None), bool, int, float, complex, str)


_OBJ_RE = __import__('re').compile(r'<(?:__main__\.)?([A-Za-z_][A-Za-z0-9_.]*) object at 0x[0-9A-Fa-f]+>')


def _short(v, n=60):
    try:
        r = repr(v)
    except Exception:
        r = '<?>'
    if ' object at 0x' in r:
        r = _OBJ_RE.sub(lambda m: m.group(1) + ' object', r)
    return r if len(r) <= n else r[:n - 3] + '...'


def _slots_of(cls):
    out = []
    for c in getattr(cls, '__mro__', ()):
        sl = c.__dict__.get('__slots__', ())
        if isinstance(sl, str):
            sl = (sl,)
        out += [x for x in sl if x not in out]
    return out


def _cell(x):
    t = str(x)
    return t if len(t) <= 24 else t[:23] + '…'


def _oid(v):
    k = id(v)
    m = _S['ids']
    if k not in m:
        m[k] = 'o%d' % (len(m) + 1)
        _S['keep'].append(v)
    return m[k]


def _fid(f):
    k = id(f)
    m = _S['fids']
    if k not in m:
        m[k] = 'f%d' % (len(m) + 1)
    return m[k]


def _sig(fn):
    try:
        return str(inspect.signature(fn))
    except Exception:
        return '(...)'


class _Snap:
    def __init__(self):
        self.heap = {}
        self.order = []

    def enc(self, v):
        if isinstance(v, _PRIM):
            return ['P', type(v).__name__, _short(v, 80)]
        if isinstance(v, types.ModuleType):
            return ['P', 'module', 'module ' + v.__name__]
        if isinstance(v, Turtle):
            return ['P', 'turtle', 'Turtle(%s, %s) %s°' % (_f(v._x), _f(v._y), _f(v._h))]
        if isinstance(v, (types.BuiltinFunctionType, types.BuiltinMethodType)):
            return ['P', 'builtin', 'built-in ' + getattr(v, '__name__', '?')]
        oid = _oid(v)
        if oid in self.heap:
            return ['R', oid]
        if len(self.order) >= _MAX_OBJ:
            return ['P', type(v).__name__, _short(v)]
        self.heap[oid] = None
        self.order.append(oid)
        self.heap[oid] = self.obj(v)
        return ['R', oid]

    def obj(self, v):
        try:
            big = len(v) > 50
        except Exception:
            big = False
        tn = type(v).__name__
        mod = getattr(type(v), '__module__', '') or ''
        if isinstance(v, io.IOBase):
            return self.file(v)
        if mod.startswith('pandas') and tn in ('DataFrame', 'Series'):
            return self.pandas(v, tn)
        if mod.startswith('numpy') and tn == 'ndarray':
            return self.ndarray(v)
        o = {'r': ('%s with %d items' % (type(v).__name__, len(v))) if big else _short(v)}
        if isinstance(v, (bytes, bytearray)):
            o['t'] = 'bytes'
            o['type'] = tn
            o['items'] = list(v[:_LIM])
            o['n'] = len(v)
            return o
        if isinstance(v, (list, tuple)) and type(v).__module__ == 'builtins':
            o['t'] = 'tuple' if isinstance(v, tuple) else 'list'
            o['items'] = [self.enc(x) for x in v[:_LIM]]
            o['n'] = len(v)
        elif isinstance(v, (set, frozenset)):
            items = list(v)
            try:
                items.sort()
            except Exception:
                pass
            o['t'] = 'set'
            o['items'] = [self.enc(x) for x in items[:_LIM]]
            o['n'] = len(v)
        elif isinstance(v, dict) and type(v).__module__ == 'builtins':
            o['t'] = 'dict'
            o['items'] = [[self.enc(k), self.enc(x)] for k, x in list(v.items())[:_LIM]]
            o['n'] = len(v)
        elif isinstance(v, types.FunctionType):
            o['t'] = 'function'
            o['name'] = v.__name__
            o['sig'] = _sig(v)
            o['r'] = ('λ%s' if v.__name__ == '<lambda>' else 'ƒ ' + v.__name__ + '%s') % o['sig']
            if v.__code__.co_flags & 0x20:
                o['gen'] = True
            if v.__closure__:
                cl = []
                for name, cell in zip(v.__code__.co_freevars, v.__closure__):
                    try:
                        cl.append([name, self.enc(cell.cell_contents)])
                    except ValueError:
                        cl.append([name, ['P', 'NoneType', '(not set yet)']])
                o['closure'] = cl
        elif isinstance(v, types.GeneratorType):
            o['t'] = 'generator'
            o['name'] = v.__name__
            try:
                o['state'] = inspect.getgeneratorstate(v).replace('GEN_', '').lower()
            except Exception:
                o['state'] = '?'
            fr = v.gi_frame
            o['line'] = fr.f_lineno if fr is not None else None
            o['attrs'] = []
            if fr is not None and o['state'] == 'suspended':
                o['attrs'] = [[k, self.enc(x)] for k, x in list(fr.f_locals.items())[:_LIM] if not k.startswith('__')]
            o['r'] = 'generator %s (%s)' % (v.__name__, o['state'])
        elif isinstance(v, types.MethodType):
            o['t'] = 'other'
            o['type'] = 'method'
            o['r'] = 'bound method %s' % v.__func__.__name__
        elif isinstance(v, type):
            o['t'] = 'class'
            o['name'] = v.__name__
            bases = [b for b in v.__bases__ if b is not object]
            o['bases'] = [b.__name__ for b in bases]
            # user-defined parent classes get an arrow ("inherits from")
            o['baserefs'] = [[b.__name__, self.enc(b)] for b in bases if getattr(b, '__module__', '') == '__main__']
            attrs = []
            slots = set(getattr(v, '__slots__', ()) or ())
            for k, x in list(v.__dict__.items()):
                fn = None
                tag = ''
                if isinstance(x, types.FunctionType):
                    fn = x
                elif isinstance(x, staticmethod):
                    fn, tag = x.__func__, '@staticmethod '
                elif isinstance(x, classmethod):
                    fn, tag = x.__func__, '@classmethod '
                elif isinstance(x, property):
                    fn, tag = x.fget, '@property '
                if fn is not None:
                    # only methods written in the program (not ones generated by @dataclass etc.)
                    if getattr(getattr(fn, '__code__', None), 'co_filename', '') != _FILE:
                        continue
                    attrs.append([k, ['P', 'method', tag + 'ƒ ' + k + (_sig(fn) if tag != '@property ' else '')]])
                elif k.startswith('__') or k in slots or type(x).__name__ in ('member_descriptor', 'getset_descriptor'):
                    continue
                else:
                    attrs.append([k, self.enc(x)])
            o['attrs'] = attrs
            dcf = v.__dict__.get('__dataclass_fields__')
            if isinstance(dcf, dict):
                o['fields'] = [[k, getattr(f.type, '__name__', str(f.type))] for k, f in dcf.items()]
            o['r'] = 'class ' + v.__name__
        elif getattr(type(v), '__module__', '') == '__main__' and (isinstance(getattr(v, '__dict__', None), dict) or _slots_of(type(v))):
            o['t'] = 'instance'
            o['cls'] = type(v).__name__
            o['clsref'] = self.enc(type(v))
            items = list(getattr(v, '__dict__', {}).items())
            for k in _slots_of(type(v)):
                if hasattr(v, k) and k != '__dict__':
                    items.append((k, getattr(v, k)))
            o['attrs'] = [[k, self.enc(x)] for k, x in items[:_LIM] if not k.startswith('__')]
            if ' object at 0x' in o['r']:
                o['r'] = '%s(%s)' % (o['cls'], ', '.join('%s=%s' % (k, x[2] if x[0] == 'P' else '…') for k, x in o['attrs'][:4]))
        else:
            o['t'] = 'other'
            o['type'] = type(v).__name__
            o['r'] = _short(v, 300)
            if tn.endswith('Shelf'):
                try:
                    o['r'] = 'shelf with keys: ' + ', '.join(sorted(v.keys())[:12])
                except Exception:
                    o['r'] = 'shelf (closed)'
        return o

    def file(self, v):
        o = {'t': 'file', 'type': type(v).__name__}
        nm = getattr(v, 'name', None)
        o['name'] = str(nm) if nm is not None else None
        o['closed'] = bool(v.closed)
        o['mode'] = getattr(v, 'mode', None) or ('memory' if isinstance(v, (io.StringIO, io.BytesIO)) else '?')
        o['enc'] = getattr(v, 'encoding', None) if not o['closed'] else None
        o['path'] = None
        if isinstance(nm, str):
            try:
                rel = os.path.relpath(os.path.abspath(nm), _DISK).replace(os.sep, '/')
                if not rel.startswith('..'):
                    o['path'] = rel
            except Exception:
                pass
        o['pos'] = None
        o['size'] = None
        if not o['closed']:
            try:
                o['pos'] = v.tell()
            except Exception:
                pass
            try:
                if isinstance(v, (io.StringIO, io.BytesIO)):
                    o['size'] = len(v.getvalue())
                elif isinstance(nm, str):
                    o['size'] = os.path.getsize(nm)
            except Exception:
                pass
        if isinstance(v, (io.StringIO, io.BytesIO)) and not o['closed']:
            o['r'] = _short(v.getvalue(), 120)
        else:
            o['r'] = '<file %s, mode %s%s>' % (repr(o['name']), repr(o['mode']), ', closed' if o['closed'] else '')
        return o

    def pandas(self, v, tn):
        o = {'t': 'table', 'type': tn, 'shape': list(getattr(v, 'shape', ()))}
        try:
            if tn == 'Series':
                o['cols'] = [str(v.name) if v.name is not None else 'value']
                o['idx'] = [str(x) for x in list(v.index[:12])]
                o['rows'] = [[_cell(x)] for x in list(v.values[:12])]
                o['dtype'] = str(v.dtype)
            else:
                cols = list(v.columns[:8])
                o['cols'] = [str(c) for c in cols]
                o['idx'] = [str(x) for x in list(v.index[:12])]
                sub = v.iloc[:12, :8]
                o['rows'] = [[_cell(x) for x in row] for row in sub.itertuples(index=False, name=None)]
                o['dtype'] = None
            o['r'] = '%s %s' % (tn, ' x '.join(str(n) for n in o['shape']))
        except Exception as e:
            o['t'] = 'other'
            o['r'] = _short(v, 300)
        return o

    def ndarray(self, v):
        o = {'t': 'table', 'type': 'ndarray', 'shape': list(v.shape), 'dtype': str(v.dtype)}
        try:
            if v.ndim == 1:
                o['cols'] = [str(i) for i in range(min(len(v), 16))]
                o['idx'] = []
                o['rows'] = [[_short(x.item() if hasattr(x, 'item') else x, 16) for x in v[:16]]]
            elif v.ndim == 2:
                o['cols'] = [str(i) for i in range(min(v.shape[1], 10))]
                o['idx'] = [str(i) for i in range(min(v.shape[0], 10))]
                o['rows'] = [[_short(x.item() if hasattr(x, 'item') else x, 16) for x in row[:10]] for row in v[:10]]
            else:
                raise ValueError
            o['r'] = 'array shape %s' % (tuple(v.shape),)
        except Exception:
            o = {'t': 'other', 'type': 'ndarray', 'r': _short(v, 300)}
        return o


def _vp_input(prompt=''):
    """input() reads the next line of the Input box instead of the keyboard."""
    prompt = str(prompt)
    lines = _S['stdin']
    i = _S['stdin_pos']
    if i >= len(lines):
        _S['out'].append(prompt)
        raise EOFError('input() needs a value but the Input box has no more lines (it has %d). Type one value per line in the Input box.' % len(lines))
    val = lines[i]
    _S['stdin_pos'] = i + 1
    _S['out'].append(prompt + val + '\n')
    _S['inp'].append([prompt, val, i + 1])
    return val


def _vp_tap(cid, names, vals, value, kind):
    """Pass-through used inside comprehensions: records each round, returns value unchanged."""
    c = _S['comp'].get(cid)
    if c is None:
        c = _S['comp'][cid] = {'id': cid, 'names': list(names), 'rounds': [], 'n': 0, 'kept': 0}
    if kind == 'c':                      # the if-condition of a round
        c['n'] += 1
        ok = bool(value)
        if len(c['rounds']) < 40:
            c['rounds'].append({'v': [_short(x, 30) for x in vals], 'k': ok})
        if not ok:
            return value
        c['kept'] += 1
        c['_open'] = True
        return value
    # the element of a round
    if c.get('_open'):
        c['_open'] = False
        if c['rounds'] and len(c['rounds']) <= 40 and 'r' not in c['rounds'][-1] and c['rounds'][-1]['k']:
            c['rounds'][-1]['r'] = _short(value, 40)
    else:
        c['n'] += 1
        c['kept'] += 1
        if len(c['rounds']) < 40:
            c['rounds'].append({'v': [_short(x, 30) for x in vals], 'k': True, 'r': _short(value, 40)})
    return value


class _CompTap(ast.NodeTransformer):
    """Wrap the element (and the last if) of every comprehension with _vp_tap."""

    def __init__(self):
        self.n = 0
        self.info = {}

    def _names(self, gens):
        out = []
        for g in gens:
            for x in ast.walk(g.target):
                if isinstance(x, ast.Name) and x.id not in out:
                    out.append(x.id)
        return out

    def _tap(self, node, cid, names, kind):
        call = ast.Call(
            func=ast.Name('_vp_tap', ast.Load()),
            args=[ast.Constant(cid), ast.Constant(tuple(names)),
                  ast.Tuple([ast.Name(n, ast.Load()) for n in names], ast.Load()),
                  node, ast.Constant(kind)],
            keywords=[])
        return ast.copy_location(call, node)

    def _comp(self, node, kind):
        self.generic_visit(node)
        self.n += 1
        cid = 'c%d' % self.n
        names = self._names(node.generators)
        self.info[cid] = {'line': node.lineno, 'kind': kind, 'names': names,
                          'has_if': any(g.ifs for g in node.generators)}
        last = node.generators[-1]
        if last.ifs:
            last.ifs[-1] = self._tap(last.ifs[-1], cid, names, 'c')
        if isinstance(node, ast.DictComp):
            node.value = self._tap(node.value, cid, names, 'e')
        else:
            node.elt = self._tap(node.elt, cid, names, 'e')
        return node

    def visit_ListComp(self, node):
        return self._comp(node, 'list')

    def visit_SetComp(self, node):
        return self._comp(node, 'set')

    def visit_DictComp(self, node):
        return self._comp(node, 'dict')

    def visit_GeneratorExp(self, node):
        return self._comp(node, 'generator')


def _flush_files():
    # Push buffered writes to disk so the Disk view shows them right away
    for v in _S['keep']:
        if isinstance(v, io.IOBase) and not isinstance(v, (io.StringIO, io.BytesIO)):
            try:
                if not v.closed and v.writable():
                    v.flush()
            except Exception:
                pass


def _disk_entry(path, full):
    try:
        stt = os.stat(full)
    except OSError:
        return None
    key = (full, stt.st_mtime_ns, stt.st_size)
    c = _S['dcache']
    if key in c:
        return c[key]
    data = b''
    try:
        with open(full, 'rb') as f:
            data = f.read(1500)
    except OSError:
        pass
    kind, prev = 'text', ''
    binext = path.lower().endswith(('.pickle', '.pkl', '.bin', '.binary', '.dat', '.db', '.png', '.jpg'))
    try:
        if binext or b'\x00' in data:
            raise UnicodeDecodeError('utf-8', b'', 0, 1, 'binary')
        prev = data.decode('utf-8', 'strict' if stt.st_size <= len(data) else 'ignore')
    except UnicodeDecodeError:
        kind = 'bin'
        prev = list(data[:48])
    e = [path, stt.st_size, kind, prev, stt.st_size > len(data)]
    c[key] = e
    return e


def _disk():
    out = []
    try:
        for root, dirs, files in os.walk(_DISK):
            dirs.sort()
            for fn in sorted(files):
                full = os.path.join(root, fn)
                e = _disk_entry(os.path.relpath(full, _DISK).replace(os.sep, '/'), full)
                if e:
                    out.append(e)
                if len(out) >= 20:
                    break
            if len(out) >= 20:
                break
    except Exception:
        pass
    k = json.dumps(out, ensure_ascii=False)
    m = _S['dkmap']
    if k not in m:
        m[k] = len(_S['disks'])
        _S['disks'].append(out)
    return m[k]


def _frames(frame, snap):
    fl = []
    f = frame
    while f is not None:
        if f.f_code.co_filename == _FILE:
            fl.append(f)
        f = f.f_back
    fl.reverse()
    return [_frame(f, snap) for f in fl]


def _frame(f, snap, d=None):
    is_mod = f is None or f.f_code.co_name == '<module>'
    if d is None:
        d = f.f_globals if is_mod else f.f_locals
    vs = []
    for k, v in list(d.items()):
        if k.startswith('__'):
            continue
        vs.append([k, snap.enc(v)])
    return {
        'gen': bool(f is not None and f.f_code.co_flags & 0x20),
        'name': '<module>' if is_mod else f.f_code.co_name,
        'qn': '' if is_mod else getattr(f.f_code, 'co_qualname', f.f_code.co_name),
        'fid': 'global' if is_mod else _fid(f),
        'line': f.f_lineno if f is not None else 0,
        'vars': vs,
    }


def _record(frame, kind, ret=None):
    if len(_S['steps']) >= _MAX_REC:
        _S['truncated'] = True
        return
    _flush_files()
    snap = _Snap()
    st = {'line': frame.f_lineno, 'kind': kind, 'stack': _frames(frame, snap),
          'nc': len(_S['cmds']), 'no': len(_S['out'])}
    if kind == 'return':
        st['ret'] = snap.enc(ret)
        st['func'] = frame.f_code.co_name
        if frame.f_code.co_flags & 0x20:          # generator: was this a yield?
            try:
                if _OPNAME[frame.f_code.co_code[frame.f_lasti]] == 'YIELD_VALUE':
                    st['yield'] = True
            except Exception:
                pass
    st['heap'] = [[k, snap.heap[k]] for k in snap.order]
    st['dk'] = _disk()
    if kind == 'return':
        if _S.get('exf') is frame:          # the function ended because of an error
            st['raised'] = True
    else:
        _attach(st)
    _S['steps'].append(st)


def _attach(st):
    if _S['comp']:
        out = []
        for c in _S['comp'].values():
            c.pop('_open', None)
            c.update(_S['compinfo'].get(c['id'], {}))
            out.append(c)
        st['comp'] = out
        _S['comp'] = {}
    if _S['exc']:
        st['exc'] = _S['exc']
        _S['exc'] = None
    if _S['inp']:
        st['inp'] = _S['inp']
        _S['inp'] = []


def _tracer(frame, event, arg):
    if frame.f_code.co_filename != _FILE:
        return None
    _S['events'] += 1
    if _S['events'] > _MAX_EVENTS:
        raise _TooLong()
    if event == 'call' and frame.f_code.co_name == '<genexpr>':
        return None                       # rounds are recorded by _vp_tap instead
    if event == 'line':
        _S['last'] = frame.f_lineno
        if _S.get('exf') is frame:
            _S['exf'] = None
        _record(frame, 'line')
    elif event == 'return' and frame.f_code.co_name != '<module>':
        _record(frame, 'return', arg)
    elif event == 'exception':
        et, ev = arg[0], arg[1]
        _S['exf'] = frame
        if et not in (StopIteration, GeneratorExit, _TooLong, _TooMany) and _S['exc'] is None:
            _S['exc'] = {'type': et.__name__, 'msg': str(ev)[:160], 'line': frame.f_lineno,
                         'func': frame.f_code.co_name}
    return _tracer


class _Out:
    def write(self, s):
        if s:
            _S['out'].append(str(s))
        return len(s)

    def flush(self):
        pass


def _figs():
    out = []
    plt = sys.modules.get('matplotlib.pyplot')
    if plt is None:
        return out
    try:
        for num in plt.get_fignums():
            fig = plt.figure(num)
            buf = io.BytesIO()
            fig.savefig(buf, format='png', dpi=110, bbox_inches='tight')
            out.append(base64.b64encode(buf.getvalue()).decode('ascii'))
        plt.close('all')
    except Exception as e:
        _S['out'].append('\n[matplotlib] %s\n' % e)
    return out


# ------------------------------------------------------------------
# Flowchart from the syntax tree (ast)
# ------------------------------------------------------------------

def _flow(src):
    try:
        tree = ast.parse(src)
    except SyntaxError:
        return None
    funcs = []

    def seg(node, n=40):
        s = ast.get_source_segment(src, node) or ''
        s = ' '.join(s.split())
        return s if len(s) <= n else s[:n - 1] + '…'

    def has_call(node, names):
        for x in ast.walk(node):
            if isinstance(x, ast.Call) and isinstance(x.func, ast.Name) and x.func.id in names:
                return True
        return False

    def args_of(fn):
        a = [x.arg for x in fn.args.args]
        if fn.args.vararg:
            a.append('*' + fn.args.vararg.arg)
        if fn.args.kwarg:
            a.append('**' + fn.args.kwarg.arg)
        return ', '.join(a)

    def block(stmts, owner):
        return [stmt(s, owner) for s in stmts]

    def add_func(s, owner):
        name = owner + s.name
        funcs.append({'title': 'function ' + name, 'start': 'def %s(%s)' % (s.name, args_of(s)),
                      'end': 'end of function', 'body': block(s.body, name + '.')})

    def stmt(s, owner):
        L = s.lineno
        if isinstance(s, (ast.FunctionDef, ast.AsyncFunctionDef)):
            add_func(s, owner)
            return {'t': 'simple', 'k': 'def', 'text': 'define function %s' % s.name, 'line': L}
        if isinstance(s, ast.ClassDef):
            for b in s.body:
                if isinstance(b, (ast.FunctionDef, ast.AsyncFunctionDef)):
                    add_func(b, owner + s.name + '.')
            return {'t': 'simple', 'k': 'def', 'text': 'define class %s' % s.name, 'line': L}
        if isinstance(s, ast.If):
            return {'t': 'if', 'text': seg(s.test), 'line': L,
                    'body': block(s.body, owner), 'orelse': block(s.orelse, owner)}
        if isinstance(s, (ast.For, ast.AsyncFor)):
            return {'t': 'loop', 'k': 'for', 'text': 'for %s in %s' % (seg(s.target, 14), seg(s.iter, 24)),
                    'line': L, 'body': block(s.body, owner)}
        if isinstance(s, ast.While):
            return {'t': 'loop', 'k': 'while', 'text': 'while ' + seg(s.test, 34), 'line': L,
                    'body': block(s.body, owner)}
        if isinstance(s, ast.Try) or s.__class__.__name__ == 'TryStar':
            items = [{'t': 'simple', 'k': 'jump', 'text': 'try:', 'line': L}] + block(s.body, owner)
            handlers = []
            for h in s.handlers:
                handlers.append({'t': 'simple', 'k': 'jump', 'text': 'except ' + (seg(h.type, 24) if h.type else ''), 'line': h.lineno})
                handlers += block(h.body, owner)
            if handlers:
                items.append({'t': 'if', 'text': 'exception raised?', 'line': 0, 'body': handlers, 'orelse': block(s.orelse, owner)})
            items += block(s.finalbody, owner)
            return {'t': 'seq', 'items': items}
        if s.__class__.__name__ == 'Match':
            # match/case becomes a chain of decisions, one per case
            subj = seg(s.subject, 20)
            chain = []
            for c in reversed(s.cases):
                pat = seg(c.pattern, 22)
                txt = '%s matches %s' % (subj, pat) if pat != '_' else None
                body = block(c.body, owner)
                if txt is None:
                    chain = body
                else:
                    chain = [{'t': 'if', 'text': txt + ('' if c.guard is None else ' and ' + seg(c.guard, 14)),
                              'line': c.pattern.lineno, 'body': body, 'orelse': chain}]
            return {'t': 'seq', 'items': [{'t': 'simple', 'k': 'process', 'text': 'match ' + subj, 'line': L}] + chain}
        if isinstance(s, (ast.With, ast.AsyncWith)):
            head = 'with ' + ', '.join(seg(i.context_expr, 26) for i in s.items)
            return {'t': 'seq', 'items': [{'t': 'simple', 'k': 'process', 'text': head, 'line': L}] + block(s.body, owner)}
        if isinstance(s, ast.Return):
            return {'t': 'simple', 'k': 'return', 'text': 'return ' + (seg(s.value, 32) if s.value else ''), 'line': L}
        if isinstance(s, (ast.Break, ast.Continue, ast.Pass)):
            return {'t': 'simple', 'k': 'jump', 'text': type(s).__name__.lower(), 'line': L}
        if isinstance(s, (ast.Import, ast.ImportFrom)):
            return {'t': 'simple', 'k': 'import', 'text': seg(s), 'line': L}
        k = 'io' if has_call(s, ('print', 'input')) else 'process'
        return {'t': 'simple', 'k': k, 'text': seg(s), 'line': L}

    main = {'title': 'main program', 'start': 'start', 'end': 'end', 'body': block(tree.body, '')}
    return [main] + funcs


# ------------------------------------------------------------------
# Running
# ------------------------------------------------------------------

_OPNAME = __import__('dis').opname


def _set_stdin(text):
    _S['stdin_next'] = text.split('\n') if text else []
    if _S['stdin_next'] and _S['stdin_next'][-1] == '':
        _S['stdin_next'].pop()


def _run(src):
    _reset()
    res = {'ok': True, 'error': None, 'steps': _S['steps'], 'cmds': _S['cmds'], 'out': _S['out'],
           'truncated': False, 'maxRec': _MAX_REC, 'figs': [], 'flow': None, 'disks': []}
    try:
        res['flow'] = _flow(src)
    except Exception:
        res['flow'] = None
    _S['compinfo'] = {}
    try:
        tree = ast.parse(src, _FILE)
        tap = _CompTap()
        tree = ast.fix_missing_locations(tap.visit(tree))
        _S['compinfo'] = tap.info
        code = compile(tree, _FILE, 'exec')
    except SyntaxError as e:
        res['ok'] = False
        res['error'] = {'type': type(e).__name__, 'msg': str(e.msg), 'line': e.lineno or 1, 'name': None}
        return json.dumps(res, ensure_ascii=False)

    bi = dict(builtins.__dict__)
    bi['input'] = _vp_input
    bi['_vp_tap'] = _vp_tap
    g = {'__name__': '__main__', '__builtins__': bi}
    old = sys.stdout
    sys.stdout = _Out()
    err = None
    sys.settrace(_tracer)
    try:
        exec(code, g)
    except _TooLong:
        err = {'type': 'TooLong', 'msg': 'Program stopped after %d steps' % _MAX_EVENTS, 'line': _S['last'], 'name': None}
    except _TooMany:
        err = {'type': 'TooMany', 'msg': 'Program stopped after %d drawing commands' % _MAX_CMDS, 'line': _S['last'], 'name': None}
    except BaseException as e:
        ln = 0
        tb = e.__traceback__
        while tb is not None:
            if tb.tb_frame.f_code.co_filename == _FILE:
                ln = tb.tb_lineno
            tb = tb.tb_next
        nm = getattr(e, 'name', None)
        err = {'type': type(e).__name__, 'msg': str(e), 'line': ln or _S['last'],
               'name': str(nm) if nm else None}
    finally:
        sys.settrace(None)
        sys.stdout = old

    res['figs'] = _figs()
    _flush_files()
    snap = _Snap()
    _S['steps'].append({
        'line': err['line'] if err else _S['last'],
        'kind': 'error' if err else 'end',
        'stack': [_frame(None, snap, g)],
        'heap': None,
        'nc': len(_S['cmds']), 'no': len(_S['out']),
    })
    _S['steps'][-1]['heap'] = [[k, snap.heap[k]] for k in snap.order]
    _S['steps'][-1]['dk'] = _disk()
    _attach(_S['steps'][-1])
    res['disks'] = _S['disks']
    res['ok'] = err is None
    res['error'] = err
    res['truncated'] = _S['truncated']
    return json.dumps(res, ensure_ascii=False)
`;
