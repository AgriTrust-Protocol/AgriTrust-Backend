import * as crypto from 'crypto';

export interface VerifiableCredential {
  '@context': string | string[];
  id?: string;
  type: string | string[];
  issuer: string;
  issuanceDate: string;
  credentialSubject: Record<string, any>;
  proof?: Proof;
}

export interface Proof {
  type: string;
  created: string;
  proofPurpose: string;
  verificationMethod: string;
  signatureValue: string;
}

export interface Certificate {
  id: string;
  type: string[];
  issuer: string;
  subject: string;
  claims: Record<string, any>;
}

export class VCEngine {
  private privateKey: crypto.KeyObject;
  private publicKey: crypto.KeyObject;

  constructor() {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
    this.privateKey = privateKey;
    this.publicKey = publicKey;
  }

  issueCredential(certificate: Certificate): VerifiableCredential {
    const issuanceDate = new Date().toISOString();
    const credential: VerifiableCredential = {
      '@context': [
        'https://www.w3.org/2018/credentials/v1',
        'https://agritrust.example.org/contexts/agritrust-v1.jsonld',
      ],
      id: certificate.id,
      type: certificate.type,
      issuer: certificate.issuer,
      issuanceDate,
      credentialSubject: {
        id: certificate.subject,
        ...certificate.claims,
      },
    };

    const proof = this.createProof(credential);
    credential.proof = proof;

    return credential;
  }

  verifyCredential(credential: VerifiableCredential): boolean {
    if (!credential.proof) {
      return false;
    }

    try {
      const signature = Buffer.from(credential.proof.signatureValue, 'base64');
      const data = this.canonicalizeForSigning(credential);
      return crypto.verify(
        null,
        Buffer.from(data),
        this.publicKey,
        signature
      );
    } catch (error) {
      return false;
    }
  }

  private createProof(credential: VerifiableCredential): Proof {
    const created = new Date().toISOString();
    const data = this.canonicalizeForSigning(credential);
    const signature = crypto.sign(null, Buffer.from(data), this.privateKey);
    const signatureValue = signature.toString('base64');

    return {
      type: 'Ed25519Signature2020',
      created,
      proofPurpose: 'assertionMethod',
      verificationMethod: `${credential.issuer}#keys-1`,
      signatureValue,
    };
  }

  private canonicalizeForSigning(credential: VerifiableCredential): string {
    // Create a copy without proof for signing
    const { proof, ...credentialWithoutProof } = credential;
    return JSON.stringify(credentialWithoutProof);
  }
}

export default VCEngine;
