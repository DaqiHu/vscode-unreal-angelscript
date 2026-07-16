import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DBType } from '../src/database.js';

describe('DBType - isInterface flag', () => {

    it('T3.9: new DBType has isInterface defaulting to false', () => {
        const t = new DBType();
        t.name = 'TestType';
        assert.equal(t.isInterface, false, 'New DBType should have isInterface = false');
    });

    it('T3.9: setting isInterface to true is preserved', () => {
        const t = new DBType();
        t.name = 'TestInterface';
        t.isInterface = true;
        assert.equal(t.isInterface, true, 'After setting, isInterface should be true');
    });

    it('T3.9: fromJSON with isInterface:true sets the flag', () => {
        const t = new DBType();
        t.fromJSON('TestInterface', { isInterface: true });
        assert.equal(t.isInterface, true, 'fromJSON should set isInterface from input');
    });

    it('T3.9: fromJSON without isInterface sets isInterface to false', () => {
        const t = new DBType();
        t.name = 'TestType';
        t.isInterface = true;  // pre-set to true
        t.fromJSON('TestType', {});
        assert.equal(t.isInterface, false, 'fromJSON without isInterface should reset to false');
    });

    it('T3.9: fromJSON with explicit isInterface:false sets isInterface to false', () => {
        const t = new DBType();
        t.name = 'TestType';
        t.fromJSON('TestType', { isInterface: false });
        assert.equal(t.isInterface, false, 'fromJSON with isInterface:false should set isInterface to false');
    });

    it('T3.9: isInterface coexists with isStruct/isEnum/isDelegate flags', () => {
        const t = new DBType();
        t.fromJSON('MixedType', {
            isInterface: true,
            isStruct: false,
            isEnum: false,
        });
        assert.equal(t.isInterface, true, 'isInterface should be true');
        assert.equal(t.isStruct, false, 'isStruct should be false');
        assert.equal(t.isEnum, false, 'isEnum should be false');
    });
});
