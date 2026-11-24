# Visual Python

Write **any Python code** and see it drawn, step by step.

## Run
Double-click `start.bat`, then wait for "Python ready" (needs internet the first time).

## Three views
| Tab | What it draws |
|---|---|
| **Memory** | Variables, lists, dicts, objects and the arrows between them. Each function call gets its own frame (great for recursion and linked lists). |
| **Flowchart** | Built automatically from any code: if, for, while, try, functions and classes. The current step is highlighted, with a run count next to each shape. |
| **Graphics** | `matplotlib` charts and `turtle` drawings. |

## Shapes in Memory
Each kind of value has its own shape (a legend at the top lists the ones in use):

| Shape | Kind |
|---|---|
| Dashed box on grid paper | **class** (a blueprint), with its methods as pills |
| Rounded card with a thick left edge | **object** (instance); a dashed grey arrow points to its class |
| Capsule | **function** |
| Square boxes in a row | **list** · double border = **tuple** (cannot change) · round = **set** |
| Key / value table | **dict** |
| Grid | pandas **DataFrame / Series**, numpy **array** |
| Sheet with a folded corner | **file object**: mode, open/closed, cursor position |
| Folder tab with numbered lines | **file on disk**: content with visible `\n`, or hex bytes for binary files |

## Files (open, with, pickle, csv, pandas)
Programs run inside a virtual disk folder in the browser. `data.txt` is there from the start.
- The **Disk** column shows every file and its content, updated at each step.
- When a file is open for reading, the already-read text is shaded and a red line marks the **cursor**.
- The explanation shows what each step did to a file: opened (and what the mode means), read or wrote N characters, closed (automatically at the end of a `with` block), and created, grew, emptied or deleted on disk.
- **Reset disk** deletes the files your programs created.

## Also covered
- **input()**: values come from the **Input** box under the code (one per line), which opens by itself when the code uses `input()`.
- **try / except / finally / raise**: shows the error, where Python jumps, and which `except` matches.
- **Comprehensions** (list, set, dict, generator expressions): a table of every round, showing the loop variable, whether it was kept, and the value added.
- **Generators** (`yield`): the generator object shows its state (paused at line N) and its saved variables; steps explain start, yield, pause and resume.
- **Closures, lambda, global, nonlocal**: the function box lists the values it remembers.
- **Strings**: indexing, slicing and `for ch in text` show the characters with positive and negative indexes, with the selected ones highlighted.
- **match / case** (drawn as decisions in the flowchart), decorators, `del`, `assert`.

## Layout
- Drag the **bar under the code** to make the code area taller or shorter, and the **divider between the columns** to make the code wider or narrower. Double-click either one to reset it. The arrow keys work too. Your sizes are remembered.
- The page adapts to every screen. On wide screens the columns sit side by side. On tablets and phones the drawing goes under the code, and the buttons grow larger for touch.

## Interaction
- **Drag any box** in Memory; the arrows follow and the position is kept while stepping.
- **Drag any chart** in the Flowchart.
- **Hover** a variable or box to highlight its arrows and linked boxes.
- **Zoom** with the buttons or **Ctrl + mouse wheel**; drag the background to pan.
- **Reset layout** puts everything back.
- **Step by step**: Prev / Next buttons or the ← / → keys.

## Features
- A plain-English explanation of every step, plus friendly error messages
- Auto-run while typing
- Packages (numpy, matplotlib, …) load automatically when imported
- Deep links: `index.html#tab=flow&step=5`

## Files
- `js/engine.js` — Python engine (tracing, memory snapshots, flowchart, turtle)
- `js/app.js` — UI and drawing
- `js/examples.js` — the "Try an example" menu
- `css/style.css` — styles
