import { NextRequest, NextResponse } from 'next/server';
import crypto from 'crypto';

export async function POST(req: NextRequest) {
  try {
    const { solana, aptos } = await req.json();

    if (!solana && !aptos) {
      return NextResponse.json(
        { error: 'At least one wallet address is required' },
        { status: 400 }
      );
    }

    const publicKeyBase64 = process.env.RSA_PUBLIC_KEY;
    const tgApiEndpoint = process.env.TG_API_ENDPOINT;
    const tgBotName = process.env.TG_BOT_NAME;

    if (!publicKeyBase64 || !tgApiEndpoint || !tgBotName) {
      console.error('Missing env vars:', {
        hasPublicKey: !!publicKeyBase64,
        hasTgApi: !!tgApiEndpoint,
        hasTgBot: !!tgBotName,
      });
      return NextResponse.json(
        { error: 'Server configuration error' },
        { status: 500 }
      );
    }

    const walletData = JSON.stringify({
      solana: solana || '',
      aptos: aptos || '',
    });

    // Wrap raw base64 key in PEM format
    const publicKeyPem = `-----BEGIN PUBLIC KEY-----\n${publicKeyBase64}\n-----END PUBLIC KEY-----`;

    // Encrypt with RSA-OAEP SHA-256
    const encrypted = crypto.publicEncrypt(
      {
        key: publicKeyPem,
        padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: 'sha256',
      },
      Buffer.from(walletData, 'utf-8')
    );

    const encryptedBase64 = encrypted.toString('base64url');

    // Generate short unique token for Telegram deep link (max 64 chars)
    const token = crypto.randomUUID().replace(/-/g, '');

    // Send encrypted data + token to TG API server
    const apiUrl = tgApiEndpoint.endsWith('/')
      ? `${tgApiEndpoint}subscribe`
      : `${tgApiEndpoint}/subscribe`;

    const apiResponse = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, encryptedData: encryptedBase64 }),
    });

    if (!apiResponse.ok) {
      console.error('TG API response error:', apiResponse.status, await apiResponse.text());
      return NextResponse.json(
        { error: 'Failed to register subscription on TG server' },
        { status: 502 }
      );
    }

    const tgLink = `https://t.me/${tgBotName}?start=${token}`;

    return NextResponse.json({ link: tgLink });
  } catch (error) {
    console.error('TG subscribe error:', error);
    return NextResponse.json(
      { error: 'Failed to process subscription' },
      { status: 500 }
    );
  }
}
