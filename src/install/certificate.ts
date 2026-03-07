/**
 * Certificate generation and system trust store management.
 *
 * Generates a local CA, installs it as trusted, then issues domain certificates
 * for api.anthropic.com and api.openai.com signed by that CA.
 */
import forge from 'node-forge';
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';
import { getTrimrDir } from './paths.js';

const CERT_DIR = join(getTrimrDir(), 'certs');
const CA_KEY_FILE = join(CERT_DIR, 'trimr-ca.key');
const CA_CERT_FILE = join(CERT_DIR, 'trimr-ca.pem');
const CA_CN = 'Trimr Local CA';

export const INTERCEPTED_DOMAINS = ['api.anthropic.com', 'api.openai.com'];

// ── Helpers ───────────────────────────────────────────────────────────────────

function ensureCertDir(): void {
  if (!existsSync(CERT_DIR)) mkdirSync(CERT_DIR, { recursive: true });
}

function generateSerial(): string {
  // Random 16-byte hex serial
  const bytes = forge.random.getBytesSync(16);
  return forge.util.bytesToHex(bytes);
}

// ── CA generation ─────────────────────────────────────────────────────────────

export interface CACert {
  key: forge.pki.rsa.PrivateKey;
  cert: forge.pki.Certificate;
}

export function generateCA(): CACert {
  ensureCertDir();

  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();

  cert.publicKey = keys.publicKey;
  cert.serialNumber = generateSerial();
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date();
  cert.validity.notAfter.setFullYear(cert.validity.notAfter.getFullYear() + 10);

  const attrs = [
    { name: 'commonName', value: CA_CN },
    { name: 'organizationName', value: 'Trimr' },
  ];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);

  cert.setExtensions([
    { name: 'basicConstraints', cA: true, critical: true },
    { name: 'keyUsage', keyCertSign: true, cRLSign: true, critical: true },
    { name: 'subjectKeyIdentifier' },
  ]);

  cert.sign(keys.privateKey, forge.md.sha256.create());

  // Persist
  writeFileSync(CA_KEY_FILE, forge.pki.privateKeyToPem(keys.privateKey));
  writeFileSync(CA_CERT_FILE, forge.pki.certificateToPem(cert));

  return { key: keys.privateKey, cert };
}

export function loadCA(): CACert | null {
  if (!existsSync(CA_KEY_FILE) || !existsSync(CA_CERT_FILE)) return null;
  try {
    const key = forge.pki.privateKeyFromPem(readFileSync(CA_KEY_FILE, 'utf8'));
    const cert = forge.pki.certificateFromPem(readFileSync(CA_CERT_FILE, 'utf8'));
    return { key, cert };
  } catch {
    return null;
  }
}

export function getOrCreateCA(): CACert {
  return loadCA() ?? generateCA();
}

// ── Domain certificate generation ─────────────────────────────────────────────

export interface DomainCert {
  key: string;   // PEM
  cert: string;  // PEM
}

export function generateDomainCert(domain: string, ca: CACert): DomainCert {
  ensureCertDir();

  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();

  cert.publicKey = keys.publicKey;
  cert.serialNumber = generateSerial();
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date();
  cert.validity.notAfter.setFullYear(cert.validity.notAfter.getFullYear() + 2);

  cert.setSubject([{ name: 'commonName', value: domain }]);
  cert.setIssuer(ca.cert.subject.attributes);

  cert.setExtensions([
    { name: 'basicConstraints', cA: false },
    { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, critical: true },
    { name: 'extKeyUsage', serverAuth: true },
    {
      name: 'subjectAltName',
      altNames: [{ type: 2 /* DNS */, value: domain }],
    },
  ]);

  cert.sign(ca.key, forge.md.sha256.create());

  const keyPem = forge.pki.privateKeyToPem(keys.privateKey);
  const certPem = forge.pki.certificateToPem(cert);

  writeFileSync(join(CERT_DIR, `${domain}.key`), keyPem);
  writeFileSync(join(CERT_DIR, `${domain}.pem`), certPem);

  return { key: keyPem, cert: certPem };
}

export function loadDomainCert(domain: string): DomainCert | null {
  const keyPath = join(CERT_DIR, `${domain}.key`);
  const certPath = join(CERT_DIR, `${domain}.pem`);
  if (!existsSync(keyPath) || !existsSync(certPath)) return null;
  try {
    return {
      key: readFileSync(keyPath, 'utf8'),
      cert: readFileSync(certPath, 'utf8'),
    };
  } catch {
    return null;
  }
}

export function getOrCreateDomainCert(domain: string, ca: CACert): DomainCert {
  return loadDomainCert(domain) ?? generateDomainCert(domain, ca);
}

// ── System trust store ────────────────────────────────────────────────────────

export function installCATrust(): { success: boolean; message: string } {
  if (!existsSync(CA_CERT_FILE)) {
    return { success: false, message: 'CA certificate not found. Run certificate generation first.' };
  }

  const platform = process.platform;

  try {
    if (platform === 'win32') {
      // Import into Windows Trusted Root store (requires elevation)
      execSync(
        `certutil -addstore -f "Root" "${CA_CERT_FILE}"`,
        { stdio: 'pipe' },
      );
      return { success: true, message: 'CA installed in Windows Trusted Root Certification Authorities' };
    }

    if (platform === 'darwin') {
      execSync(
        `sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain "${CA_CERT_FILE}"`,
        { stdio: 'pipe' },
      );
      return { success: true, message: 'CA installed in macOS System Keychain' };
    }

    // Linux
    const certDest = '/usr/local/share/ca-certificates/trimr-ca.crt';
    execSync(`sudo cp "${CA_CERT_FILE}" "${certDest}"`, { stdio: 'pipe' });
    execSync('sudo update-ca-certificates', { stdio: 'pipe' });
    return { success: true, message: 'CA installed in Linux ca-certificates' };
  } catch (e) {
    return { success: false, message: `Failed to install CA: ${(e as Error).message}` };
  }
}

export function removeCATrust(): { success: boolean; message: string } {
  const platform = process.platform;

  try {
    if (platform === 'win32') {
      execSync(
        `certutil -delstore "Root" "${CA_CN}"`,
        { stdio: 'pipe' },
      );
      return { success: true, message: 'CA removed from Windows trust store' };
    }

    if (platform === 'darwin') {
      if (existsSync(CA_CERT_FILE)) {
        execSync(
          `sudo security remove-trusted-cert -d "${CA_CERT_FILE}"`,
          { stdio: 'pipe' },
        );
      }
      return { success: true, message: 'CA removed from macOS Keychain' };
    }

    // Linux
    const certDest = '/usr/local/share/ca-certificates/trimr-ca.crt';
    if (existsSync(certDest)) {
      execSync(`sudo rm "${certDest}"`, { stdio: 'pipe' });
      execSync('sudo update-ca-certificates --fresh', { stdio: 'pipe' });
    }
    return { success: true, message: 'CA removed from Linux ca-certificates' };
  } catch (e) {
    return { success: false, message: `Failed to remove CA: ${(e as Error).message}` };
  }
}

export function removeCertFiles(): void {
  const files = [
    CA_KEY_FILE, CA_CERT_FILE,
    ...INTERCEPTED_DOMAINS.flatMap(d => [
      join(CERT_DIR, `${d}.key`),
      join(CERT_DIR, `${d}.pem`),
    ]),
  ];
  for (const f of files) {
    try { unlinkSync(f); } catch { /* ignore */ }
  }
}

export function getCACertPath(): string {
  return CA_CERT_FILE;
}

export function getCertDir(): string {
  return CERT_DIR;
}
