import test from 'node:test';import assert from 'node:assert/strict';
import {normalizePhone,passwordIssue,validEmail,clean,sha256,resetCode} from '../netlify/functions/lib/util.js';
test('téléphone',()=>{assert.equal(normalizePhone('+221 77 123 45 67'),'771234567');assert.equal(normalizePhone('771234567'),'771234567');
  assert.equal(normalizePhone('12345'),null);assert.equal(normalizePhone('+22199 123 45 67'),null);assert.equal(normalizePhone(null),null);});
test('mot de passe',()=>{assert.ok(passwordIssue('court1'));assert.ok(passwordIssue('uniquementlettres'));assert.ok(passwordIssue('1234567890'));assert.equal(passwordIssue('Kayligey2026ok'),null);});
test('email',()=>{assert.ok(validEmail('a@b.sn'));assert.ok(!validEmail('a@b'));assert.ok(!validEmail('a b@c.sn'));});
test('nettoyage et code',()=>{assert.equal(clean('<b>Moi</b>'),'bMoi/b');assert.equal(sha256('a').length,64);assert.match(resetCode(),/^\d{6}$/);});
