// faux objet res avec juste ce qu'utilisent les handlers
export function fakeRes() {
  const res = {
    statusCode: 200,
    headers: {},
    body: undefined,
    status(code) {
      res.statusCode = code;
      return res;
    },
    set(name, value) {
      res.headers[name.toLowerCase()] = value;
      return res;
    },
    json(data) {
      res.body = data;
      return res;
    },
    send(data) {
      res.body = data;
      return res;
    },
  };
  return res;
}

// logger qui garde les messages en mémoire au lieu de les afficher
export function fakeLogger() {
  const logs = [];
  return {
    logs,
    info: (...args) => logs.push(["info", ...args]),
    warn: (...args) => logs.push(["warn", ...args]),
    error: (...args) => logs.push(["error", ...args]),
  };
}
