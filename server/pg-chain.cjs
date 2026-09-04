// Read-only capture of the Supabase pooler's TLS certificate chain.
// Writes the chain as PEM files (public certificates, no secrets) so the
// root/intermediate can be installed into the Windows trust store.
const net = require('net');
const tls = require('tls');
const fs = require('fs');
const host = 'aws-0-us-east-2.pooler.supabase.com';
const outDir = process.argv[2] || '.';

function pemChain(port) {
  return new Promise((resolve) => {
    const raw = net.connect({ host, port });
    const t = setTimeout(() => { raw.destroy(); resolve(null); }, 12000);
    raw.on('connect', () => raw.write(Buffer.from([0, 0, 0, 8, 0x04, 0xd2, 0x16, 0x2f])));
    raw.on('data', function first(d) {
      raw.removeListener('data', first);
      if (d[0] !== 0x53) { clearTimeout(t); return resolve(null); }
      const sec = tls.connect({ socket: raw, rejectUnauthorized: false, servername: host }, () => {
        const chain = sec.getPeerCertificate(true);
        clearTimeout(t); sec.destroy();
        const certs = [];
        let c = chain;
        const seen = new Set();
        while (c && c.raw && !seen.has(c.fingerprint)) {
          seen.add(c.fingerprint);
          certs.push(c);
          c = c.issuerCertificate && c.issuerCertificate.fingerprint !== c.fingerprint ? c.issuerCertificate : null;
        }
        resolve(certs);
      });
      sec.on('error', () => { clearTimeout(t); resolve(null); });
    });
    raw.on('error', () => { clearTimeout(t); resolve(null); });
  });
}

(async () => {
  const certs = await pemChain(5432);
  if (!certs) { console.log('FAILED to capture chain'); process.exit(1); }
  console.log(`captured ${certs.length} certificate(s):`);
  certs.forEach((c, i) => {
    const label = i === 0 ? 'leaf' : i === certs.length - 1 ? 'root' : `intermediate-${i}`;
    const pem = ['-----BEGIN CERTIFICATE-----',
      c.raw.toString('base64').replace(/(.{64})/g, '$1\n'),
      '-----END CERTIFICATE-----', ''].join('\n');
    const file = `${outDir}\\supabase-chain-${i}-${label}.pem`;
    fs.writeFileSync(file, pem);
    console.log(`  [${i}] ${label}: CN=${c.subject && c.subject.CN} | issuer CN=${c.issuer && c.issuer.CN} -> ${file}`);
  });
})();
