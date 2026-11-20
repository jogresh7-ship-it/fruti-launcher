#!/usr/bin/env python3
"""Make base64 .js copies of the EmulatorJS files it downloads at runtime,
so n64.html works from file:// (no server). Output: emulatorjs/embed/*.js"""
import base64, os
root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
data = os.path.join(root, "emulatorjs", "data")
# every core (.data), core report (.json) and decompressor shipped in emulatorjs/data
files = ["compression/extract7z.js", "compression/extractzip.js"]
for sub in ("cores", "cores/reports"):
    for name in sorted(os.listdir(os.path.join(data, sub))):
        if name.endswith((".data", ".json")):
            files.append(sub + "/" + name)
out = os.path.join(root, "emulatorjs", "embed")
os.makedirs(out, exist_ok=True)
for key in files:
    b64 = base64.b64encode(open(os.path.join(data, key), "rb").read()).decode()
    name = key.replace("/", "__") + ".js"
    with open(os.path.join(out, name), "w") as f:
        f.write('(window.FRUTI_EJS=window.FRUTI_EJS||{})["%s"]="%s";\n' % (key, b64))
    print(name, len(b64) // 1024, "KB")
