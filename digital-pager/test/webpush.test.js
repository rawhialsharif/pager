// Checks the push encryption against the worked example in RFC 8291 Appendix A,
// and checks that VAPID tokens verify with the public key.

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { encryptPayload, fromB64u, b64u, createVapidJwt, generateVapidKeys, isAllowedPushEndpoint } from '../src/webpush.js';

const RFC = {
  plaintext: 'V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  asPublic: 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  uaPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  authSecret: 'BTBZMqHH6r4Tts7J_aSIgg',
  header: 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  ciphertext: '8pfeW0KbunFT06SuDKoJH9Ql87S1QUrdirN6GcG7sFz1y1sqLgVi1VhjVkHsUoEsbI_0LpXMuGvnzQ',
  body:
    'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml' +
    'mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT' +
    'pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
};

test('encryption matches the RFC 8291 example byte for byte', () => {
  const serverEcdh = crypto.createECDH('prime256v1');
  serverEcdh.setPrivateKey(fromB64u(RFC.asPrivate));
  assert.equal(b64u(serverEcdh.getPublicKey()), RFC.asPublic);

  const out = encryptPayload({
    plaintext: fromB64u(RFC.plaintext),
    uaPublic: fromB64u(RFC.uaPublic),
    authSecret: fromB64u(RFC.authSecret),
    serverEcdh,
    salt: fromB64u(RFC.salt),
  });

  assert.equal(b64u(out.subarray(0, 86)), RFC.header);
  assert.equal(b64u(out.subarray(86)), RFC.ciphertext);
  assert.equal(b64u(out), RFC.body);
});

test('VAPID token is a valid ES256 JWT for the given audience', () => {
  const keys = generateVapidKeys();
  const pub = fromB64u(keys.publicKey);
  const jwk = { kty: 'EC', crv: 'P-256', x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33)) };
  const keyObject = crypto.createPrivateKey({ format: 'jwk', key: { ...jwk, d: keys.privateKey } });
  const token = createVapidJwt({ audience: 'https://fcm.googleapis.com', subject: 'mailto:test@example.com', keyObject });

  const [h, c, s] = token.split('.');
  const verified = crypto.verify(
    'sha256',
    Buffer.from(`${h}.${c}`),
    { key: crypto.createPublicKey({ format: 'jwk', key: jwk }), dsaEncoding: 'ieee-p1363' },
    fromB64u(s),
  );
  assert.ok(verified);
  const claims = JSON.parse(fromB64u(c).toString());
  assert.equal(claims.aud, 'https://fcm.googleapis.com');
  assert.ok(claims.exp > Date.now() / 1000 && claims.exp <= Date.now() / 1000 + 24 * 3600);
});

test('only real push services are accepted as endpoints', () => {
  assert.ok(isAllowedPushEndpoint('https://fcm.googleapis.com/fcm/send/abc'));
  assert.ok(isAllowedPushEndpoint('https://web.push.apple.com/QGx'));
  assert.ok(isAllowedPushEndpoint('https://updates.push.services.mozilla.com/wpush/v2/x'));
  assert.ok(!isAllowedPushEndpoint('http://fcm.googleapis.com/fcm/send/abc'));
  assert.ok(!isAllowedPushEndpoint('https://169.254.169.254/latest/meta-data'));
  assert.ok(!isAllowedPushEndpoint('https://evilfcm.googleapis.com.attacker.net/x'));
  assert.ok(!isAllowedPushEndpoint('not a url'));
});
