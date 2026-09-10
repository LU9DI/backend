import net from 'node:net';

const host = String(process.env.SMTP_HOST || 'smtp.gmail.com').trim();
const port = Number(process.env.SMTP_PORT || 587);
const timeoutMs = 10_000;

console.log(`[smtp-test] tentando ${host}:${port}`);

const socket = net.createConnection({ host, port });
let finished = false;

function finish(code: number, message: string) {
  if (finished) return;
  finished = true;
  console.log(message);
  socket.destroy();
  process.exitCode = code;
}

socket.setTimeout(timeoutMs);
socket.once('connect', () => finish(0, '[smtp-test] TCP CONECTOU'));
socket.once('timeout', () => finish(2, '[smtp-test] TCP TIMEOUT'));
socket.once('error', (err) => finish(1, `[smtp-test] TCP ERRO: ${err.message}`));
