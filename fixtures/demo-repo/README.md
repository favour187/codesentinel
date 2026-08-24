# demo-repo — intentionally vulnerable fixture

**This code is deliberately insecure. Do not copy it into a real project.**

It exists so CodeSentinel can demonstrate *genuine* detection end to end without
requiring access to a third-party repository. Every finding CodeSentinel reports
for this fixture comes from actually parsing these files.

Planted issues include hardcoded credentials, command injection, SQL injection,
unsafe deserialisation, swallowed errors, and an untested payment module.
