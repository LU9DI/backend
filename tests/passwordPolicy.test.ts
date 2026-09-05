import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validarSenhaEmpresa } from '../passwordPolicy.js';

describe('validarSenhaEmpresa', () => {
  it('rejeita senha curta', () => {
    const r = validarSenhaEmpresa('Ab1!');
    assert.equal(r.ok, false);
  });

  it('rejeita sem maiúscula', () => {
    const r = validarSenhaEmpresa('senha@123');
    assert.equal(r.ok, false);
  });

  it('rejeita sem número', () => {
    const r = validarSenhaEmpresa('Senha@abc');
    assert.equal(r.ok, false);
  });

  it('rejeita sem especial', () => {
    const r = validarSenhaEmpresa('Senha1234');
    assert.equal(r.ok, false);
  });

  it('aceita senha válida', () => {
    const r = validarSenhaEmpresa('Senha@12');
    assert.equal(r.ok, true);
  });
});
