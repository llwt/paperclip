// A test run must never talk to the live paperclipai.service unit.
delete process.env.NOTIFY_SOCKET;
