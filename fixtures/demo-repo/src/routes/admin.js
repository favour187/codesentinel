// DEMO FIXTURE — intentionally insecure.
// Planted: command injection (CWE-78), eval (CWE-95), path traversal

const { exec, execSync } = require('child_process');
const fs = require('fs');
const express = require('express');
const router = express.Router();

router.post('/backup', (req, res) => {
  const name = req.body.name;
  // Command injection: unsanitised user input in a shell command
  exec('tar -czf /backups/' + name + '.tar.gz /data', (err, stdout) => {
    res.send(stdout);
  });
});

router.get('/logs', (req, res) => {
  // Command injection via execSync
  const service = req.query.service;
  const out = execSync(`journalctl -u ${service} --no-pager`);
  res.send(out.toString());
});

router.post('/run', (req, res) => {
  // Arbitrary code execution through eval
  const result = eval(req.body.expression);
  res.json({ result });
});

router.get('/file', (req, res) => {
  // Path traversal: unvalidated path joined with a base directory
  const file = req.query.path;
  const content = fs.readFileSync('/var/app/data/' + file, 'utf8');
  res.send(content);
});

module.exports = router;
