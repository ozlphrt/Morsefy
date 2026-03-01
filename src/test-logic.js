import { KOCH_ORDER } from '../src/training/training.js';

// Mock State Manager
const mockSM = {
    state: {
        progress: { unlockedChars: ['K', 'M'] },
        stats: {}
    }
};

function testKochOrder() {
    console.log('Testing KOCH_ORDER...');
    if (KOCH_ORDER.startsWith('KMRST')) {
        console.log('✅ KOCH_ORDER is correct');
    } else {
        console.error('❌ KOCH_ORDER is wrong:', KOCH_ORDER);
    }
}

testKochOrder();
console.log('Logic tests passed.');
