import twilio from 'twilio';

export function getTwilioClient() {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;

  if (!accountSid || !authToken || accountSid === 'your_account_sid_here') {
    return null;
  }

  return twilio(accountSid, authToken);
}

export function generateAccessToken(identity: string, pushCredentialSid?: string): string {
  const AccessToken = twilio.jwt.AccessToken;
  const VoiceGrant = AccessToken.VoiceGrant;

  const accountSid = process.env.TWILIO_ACCOUNT_SID!;
  const apiKey = process.env.TWILIO_API_KEY!;
  const apiSecret = process.env.TWILIO_API_SECRET!;
  const twimlAppSid = process.env.TWILIO_TWIML_APP_SID!;

  const voiceGrant = new VoiceGrant({
    outgoingApplicationSid: twimlAppSid,
    incomingAllow: true,
    ...(pushCredentialSid ? { pushCredentialSid } : {}),
  });

  const token = new AccessToken(accountSid, apiKey, apiSecret, {
    identity,
    ttl: 3600,
  });

  token.addGrant(voiceGrant);
  return token.toJwt();
}

export function getPhoneNumbers(): string[] {
  return [
    process.env.TWILIO_PHONE_NUMBER_1,
    process.env.TWILIO_PHONE_NUMBER_2,
    process.env.TWILIO_PHONE_NUMBER_3,
  ].filter((n): n is string => Boolean(n) && !n!.startsWith('+1456'));
}

export function getRandomCallerId(): string {
  const numbers = getPhoneNumbers();
  if (numbers.length === 0) return '+10000000000';
  return numbers[Math.floor(Math.random() * numbers.length)];
}
