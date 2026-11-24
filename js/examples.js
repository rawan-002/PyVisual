/* Quick examples for the "Try an example" menu — write any code you want instead */
window.EXAMPLES = [
  {
    name: 'Lists and functions',
    code: `def square_all(numbers):
    result = []
    for n in numbers:
        result.append(n * n)
    return result

nums = [1, 2, 3, 4]
squares = square_all(nums)
print(squares)
`,
  },
  {
    name: 'Recursion',
    code: `def factorial(n):
    if n <= 1:
        return 1
    return n * factorial(n - 1)

print(factorial(5))
`,
  },
  {
    name: 'Classes and objects',
    code: `class Account:
    def __init__(self, owner, balance=0):
        self.owner = owner
        self.balance = balance

    def deposit(self, amount):
        self.balance += amount
        return self.balance

a = Account("Sara", 100)
b = Account("Ali")
a.deposit(50)
b.deposit(20)
accounts = [a, b]
`,
  },
  {
    name: 'OOP: inheritance',
    code: `class Animal:
    count = 0                      # class variable, shared by all animals

    def __init__(self, name):
        self.name = name
        Animal.count += 1

    def speak(self):
        return '...'

    def describe(self):
        return self.name + ' says ' + self.speak()

    def __str__(self):             # used by print()
        return 'Animal ' + self.name


class Dog(Animal):                 # Dog inherits from Animal
    def __init__(self, name, breed):
        super().__init__(name)     # let Animal set up the name
        self.breed = breed

    def speak(self):               # override
        return 'Woof'


class Cat(Animal):
    def speak(self):
        return 'Meow'


pets = [Dog('Rex', 'lab'), Cat('Tom')]
for p in pets:
    print(p.describe())
print(pets[0])
print('animals:', Animal.count)
`,
  },
  {
    name: 'Linked list',
    code: `class Node:
    def __init__(self, value, next=None):
        self.value = value
        self.next = next

head = None
for v in [3, 2, 1]:
    head = Node(v, head)

node = head
while node is not None:
    print(node.value)
    node = node.next
`,
  },
  {
    name: 'Bubble sort',
    code: `data = [5, 1, 4, 2, 8]

for i in range(len(data)):
    for j in range(len(data) - 1 - i):
        if data[j] > data[j + 1]:
            data[j], data[j + 1] = data[j + 1], data[j]

print(data)
`,
  },
  {
    name: 'Dictionary: word count',
    code: `text = "apple banana apple orange banana apple"
counts = {}
for word in text.split():
    if word in counts:
        counts[word] += 1
    else:
        counts[word] = 1

print(counts)
`,
  },
  {
    name: 'Chart (matplotlib)',
    code: `import matplotlib.pyplot as plt
import math

xs = [x / 10 for x in range(63)]
ys = [math.sin(x) for x in xs]

plt.plot(xs, ys, label="sin(x)")
plt.title("Sine wave")
plt.legend()
plt.show()
`,
  },
  {
    name: 'Turtle drawing',
    code: `import turtle

t = turtle.Turtle()
colors = ["red", "orange", "gold", "green", "blue", "purple"]

for i in range(36):
    t.pencolor(colors[i % 6])
    t.forward(i * 5)
    t.left(59)
`,
  },
  {
    name: 'input() and errors',
    code: `# Values come from the Input box under the code (one per line)
name = input('Your name? ')
age = int(input('Your age? '))
print('Hello', name)

try:
    years = 100 / (age - age)       # division by zero!
    print('never printed')
except ZeroDivisionError as e:
    print('Error:', e)
finally:
    print('finally always runs')

def check(n):
    if n < 0:
        raise ValueError('negative number')
    return n

try:
    check(-5)
except ValueError as err:
    print('Caught:', err)
`,
  },
  {
    name: 'Comprehensions and lambda',
    code: `nums = [1, 2, 3, 4, 5, 6]

squares = [n * n for n in nums]
evens = [n for n in nums if n % 2 == 0]
names = {'sara': 90, 'ali': 75}
upper = {k.upper(): v for k, v in names.items()}
total = sum(n * 10 for n in nums)

double = lambda x: x * 2
doubled = list(map(double, nums))
print(squares, evens, upper, total, doubled)
`,
  },
  {
    name: 'Generators (yield)',
    code: `def count_up(limit):
    i = 1
    while i <= limit:
        yield i          # give a value and pause here
        i += 1

gen = count_up(3)        # nothing runs yet!
a = next(gen)
b = next(gen)
for x in gen:            # takes the remaining values
    print(x)

def evens():
    n = 0
    while True:
        yield n
        n += 2

e = evens()
first = [next(e) for _ in range(4)]
print(a, b, first)
`,
  },
  {
    name: 'Closures, global, nonlocal',
    code: `def make_multiplier(n):
    def multiply(x):
        return x * n     # n is remembered
    return multiply

triple = make_multiplier(3)
print(triple(5))

def make_counter():
    count = 0
    def step():
        nonlocal count
        count += 1
        return count
    return step

c = make_counter()
c()
c()

total = 0
def add(v):
    global total
    total += v

add(10)
print(c(), total)
`,
  },
  {
    name: 'Strings and indexes',
    code: `word = 'Python'
first = word[0]
last = word[-1]
middle = word[1:4]
rev = word[::-1]

count = 0
for ch in word:
    if ch in 'aeiou':
        count += 1

text = 'hello world'
pos = text.find('world')
title = text.title()
print(first, last, middle, rev, count, pos, title)
`,
  },
  {
    name: 'match / case',
    code: `def describe(cmd):
    match cmd:
        case 'start':
            return 'Starting'
        case 'stop' | 'quit':
            return 'Stopping'
        case [x, y]:
            return f'Point {x},{y}'
        case _:
            return 'Unknown'

for c in ['start', 'quit', [3, 4], 'jump']:
    print(describe(c))
`,
  },
  {
    name: 'Files: write, append, read',
    code: `path = 'notes.txt'

# "w" creates the file (or erases it), write() adds no new line by itself
with open(path, 'w') as file:
    file.write('Hey')
    file.write(' you\\n')
    file.write('Your name?\\n')

# "a" keeps the old content and adds at the end
lines = ['Sara\\n', 'Ali\\n']
with open(path, 'a') as file:
    for line in lines:
        file.write(line)

# "r" reads it back
with open(path, 'r') as file:
    content = file.read()

print(content)
`,
  },
  {
    name: 'Files: reading lines',
    code: `path = 'data.txt'   # this file is already on the disk

file = open(path, 'r')
first = file.readline()     # one line, keeps its \\n
rest = file.readlines()     # all remaining lines in a list
file.close()

# The Pythonic way: with closes the file for us
with open(path) as file:
    clean = file.read().splitlines()   # lines without \\n

for line in clean:
    if line:
        print(line.upper())
`,
  },
  {
    name: 'Files: mode x and errors',
    code: `path = 'report.txt'

with open(path, 'w') as f:
    f.write('first version\\n')

# "x" only creates NEW files: the file exists now, so this fails
try:
    with open(path, 'x') as f:
        f.write('second version\\n')
except FileExistsError as e:
    print('Error:', e)

# Reading a file that does not exist
try:
    open('missing.txt', 'r')
except FileNotFoundError:
    print('missing.txt was not found')
`,
  },
  {
    name: 'Binary files and pickle',
    code: `import pickle

nums = [120, 255, 100]
with open('data.binary', 'wb') as writer:
    writer.write(bytearray(nums))      # each number is one byte (0-255)
    writer.write('abc'.encode('utf-8'))

with open('data.binary', 'rb') as reader:
    back = list(reader.read())
print(back)

# pickle saves whole Python objects as bytes
data = (2025, 'hello', [4, 5])
scores = {'Sara': 90, 'Ali': 75}
with open('data.pickle', 'wb') as f:
    pickle.dump(data, f)
    pickle.dump(scores, f)

with open('data.pickle', 'rb') as f:
    data2 = pickle.load(f)
    scores2 = pickle.load(f)
print(data2, scores2)
`,
  },
  {
    name: 'CSV files',
    code: `import csv

rows = [['name', 'item', 'cost'],
        ['Sara', 'pencil', 30],
        ['Ali', 'pen', 70],
        ['Mona', 'eraser', 20]]

with open('shop.csv', 'w', newline='') as f:
    writer = csv.writer(f)
    writer.writerows(rows)

total = 0
with open('shop.csv') as f:
    reader = csv.reader(f)
    header = next(reader)
    for row in reader:
        total += int(row[2])
print('Total cost:', total)
`,
  },
  {
    name: 'pandas DataFrame',
    code: `import pandas as pd

names = pd.Series(['Sara', 'Ali', 'Mona'], index=['s1', 's2', 's3'])

df = pd.DataFrame({
    'Student': ['Sara', 'Ali', 'Mona'],
    'purchase': ['pencil', 'pen', 'eraser'],
    'cost': [30, 70, 20],
}, index=['shop 1', 'shop 2', 'shop 2'])

df['Place'] = ['mall', 'road', 'park']
expensive = df[df['cost'] > 20]
df.to_csv('shop.csv')
back = pd.read_csv('shop.csv', index_col=0)
print(back.loc['shop 1', 'Student'])
`,
  },
];
