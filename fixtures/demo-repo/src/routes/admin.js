


const { exec, execSync } = require('child_process');
const fs = require('fs');
const express = require('express');
const { requireAdmin } = require('../auth/permissions');
const router = express.Router();

router.post('/backup', (req, res) => {

  if (!requireAdmin(req.headers['x-session-id'])) {
    return res.status(403).send('forbidden');
  }
  const name = req.body.name;

  exec('tar -czf /backups/' + name + '.tar.gz /data', (err, stdout) => {
    res.send(stdout);
  });
});

router.get('/logs', (req, res) => {

  const service = req.query.service;
  const out = execSync(`journalctl -u ${service} --no-pager`);
  res.send(out.toString());
});

router.post('/run', (req, res) => {

  const result = eval(req.body.expression);
  res.json({ result });
});

router.get('/file', (req, res) => {

  const file = req.query.path;
  const content = fs.readFileSync('/var/app/data/' + file, 'utf8');
  res.send(content);
});

module.exports = router;
