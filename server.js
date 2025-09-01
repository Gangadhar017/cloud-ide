// server.js
// Cloud IDE backend — runs Python / Java / C++ in Docker containers.
// SECURITY: Run only on trusted machines. See README.

const express = require('express');
const path = require('path');
const fs = require('fs').promises;
const os = require('os');
const { exec } = require('child_process');
const { v4: uuidv4 } = require('uuid');
const bodyParser = require('body-parser');

const app = express();
app.use(bodyParser.json({ limit: '10mb' }));
app.use(express.static('public'));

const RUN_BASE = path.join(os.tmpdir(), 'cloudide_workspaces');
(async ()=>{ await fs.mkdir(RUN_BASE, { recursive: true }); })();

function safeName(name){
  return name ? name.replace(/[^a-zA-Z0-9_.-]/g, '_') : '';
}
function clampNumber(v, min, max, def){
  const n = Number(v);
  if (Number.isNaN(n)) return def;
  return Math.max(min, Math.min(max, n));
}

/* ---------------- Workspace & file APIs ---------------- */

// Create workspace (returns id)
app.post('/workspace/create', async (req, res) => {
  try {
    const id = uuidv4();
    const dir = path.join(RUN_BASE, id);
    await fs.mkdir(dir, { recursive: true });
    // default files
    await fs.writeFile(path.join(dir, 'main.py'),
`def greet(name):
    print(f"Hello, {name}!")

if __name__ == '__main__':
    greet('World')
`);
    await fs.writeFile(path.join(dir, 'Main.java'),
`public class Main {
  public static void main(String[] args) {
    System.out.println("Hello, World!");
  }
}
`);
    await fs.writeFile(path.join(dir, 'main.cpp'),
`#include <bits/stdc++.h>
using namespace std;
int main(){ cout<<"Hello, World!\\n"; return 0; }
`);
    res.json({ workspaceId: id });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// List files
app.get('/workspace/:id/files', async (req, res) => {
  try {
    const id = safeName(req.params.id);
    const dir = path.join(RUN_BASE, id);
    const files = await fs.readdir(dir);
    res.json({ files });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Get file content
app.get('/workspace/:id/file_content', async (req, res) => {
  try {
    const id = safeName(req.params.id);
    const name = req.query.name;
    if (!name) return res.status(400).json({ error: 'name required' });
    const safe = safeName(name);
    const filePath = path.join(RUN_BASE, id, safe);
    if (!filePath.startsWith(path.join(RUN_BASE, id))) return res.status(400).json({ error: 'invalid filename' });
    const content = await fs.readFile(filePath, 'utf8');
    res.json({ content });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Save file
app.post('/workspace/:id/file', async (req, res) => {
  try {
    const id = safeName(req.params.id);
    const { filename, content } = req.body;
    if (!filename) return res.status(400).json({ error: 'filename required' });
    const safe = safeName(filename);
    const dir = path.join(RUN_BASE, id);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, safe), content || '');
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Delete file
app.delete('/workspace/:id/file', async (req, res) => {
  try {
    const id = safeName(req.params.id);
    const { filename } = req.body;
    if (!filename) return res.status(400).json({ error: 'filename required' });
    const safe = safeName(filename);
    await fs.rm(path.join(RUN_BASE, id, safe), { force: true });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* ---------------- Run code endpoint ----------------
 POST /run
 body: {
   workspaceId (optional),
   files: [{name, content}, ...] (optional),
   language: 'python'|'java'|'cpp',
   stdin: '...',
   timeLimit: seconds,
   memory: MB,
   cpus: number
 }
-----------------------------------------------------*/
app.post('/run', async (req, res) => {
  try {
    const { workspaceId, files, language, stdin } = req.body;
    if (!language) return res.status(400).json({ error: 'language required' });

    const timeLimit = clampNumber(req.body.timeLimit, 1, 30, 5);
    const memory = clampNumber(req.body.memory, 64, 2048, 512);
    const cpus = clampNumber(req.body.cpus, 0.1, 4, 0.5);

    // prepare run dir
    const runId = uuidv4();
    const runDir = path.join(RUN_BASE, 'run_' + runId);
    await fs.mkdir(runDir, { recursive: true });

    // copy workspace files if provided
    if (workspaceId) {
      const src = path.join(RUN_BASE, safeName(workspaceId));
      try {
        const items = await fs.readdir(src);
        for (const f of items) {
          try { await fs.copyFile(path.join(src, f), path.join(runDir, f)); } catch(e){}
        }
      } catch(e){}
    }

    // write supplied files
    if (Array.isArray(files)) {
      for (const item of files) {
        const name = safeName(item.name || ('file_' + uuidv4()));
        await fs.writeFile(path.join(runDir, name), item.content || '');
      }
    }

    // stdin file
    await fs.writeFile(path.join(runDir, 'input.txt'), typeof stdin === 'string' ? stdin : '');

    // choose entry file
    const list = await fs.readdir(runDir).catch(()=>[]);
    let entry = '';
    if (language === 'python') {
      entry = list.includes('main.py') ? 'main.py' : (list.find(f=>f.endsWith('.py')) || 'main.py');
    } else if (language === 'cpp') {
      entry = list.includes('main.cpp') ? 'main.cpp' : (list.find(f=>f.endsWith('.cpp')) || 'main.cpp');
    } else if (language === 'java') {
      entry = list.includes('Main.java') ? 'Main.java' : (list.find(f=>f.endsWith('.java')) || 'Main.java');
    } else {
      return res.status(400).json({ error: 'unsupported language' });
    }

    // map to docker images
    const dockerImage = { python: 'python:3.11-slim', cpp: 'gcc:12', java: 'openjdk:17' }[language];

    // compose inner command
    let inner = '';
    if (language === 'python') {
      inner = `timeout ${timeLimit}s python ${entry} < input.txt`;
      inner = `bash -lc "${inner.replace(/"/g,'\\\"')}"`;
    } else if (language === 'cpp') {
      const compile = `g++ -std=c++17 ${entry} -O2 -o a.out 2> compile.txt || true`;
      const run = `if [ -s compile.txt ]; then cat compile.txt; exit 42; else timeout ${timeLimit}s ./a.out < input.txt; fi`;
      inner = `bash -lc "${compile} && ${run}"`;
    } else if (language === 'java') {
      const compile = `javac *.java 2> compile.txt || true`;
      const run = `if [ -s compile.txt ]; then cat compile.txt; exit 42; else timeout ${timeLimit}s java Main < input.txt; fi`;
      inner = `bash -lc "${compile} && ${run}"`;
    }

    const memArg = `${memory}m`;
    const cpusArg = String(cpus);

    // docker run command — mounts runDir into /code
    // Note: if running this server inside a container, ensure /var/run/docker.sock is mounted into the container
    const dockerCmd = `docker run --rm -i --network none --memory=${memArg} --cpus=${cpusArg} -v "${runDir}:/code" -w /code ${dockerImage} ${inner}`;

    // host-level timeout a bit larger than inner timeout
    const execOpts = { timeout: (timeLimit + 10) * 1000, maxBuffer: 4 * 1024 * 1024 };

    exec(dockerCmd, execOpts, async (error, stdout, stderr) => {
      const result = { stdout: stdout || '', stderr: stderr || '' };
      if (error) {
        if (error.killed) result.error = 'Execution timed out or was killed';
        else result.error = error.message;
      }
      // return result
      res.json(result);
      // cleanup
      try { await fs.rm(runDir, { recursive: true, force: true }); } catch(e){}
    });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, ()=> console.log(`Cloud IDE server listening on http://localhost:${PORT}`));
