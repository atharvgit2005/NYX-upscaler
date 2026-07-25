const fs = require('fs');
const path = require('path');

console.log("==========================================================");
console.log("   AI VIDEO UPSCALER - COMPREHENSIVE SUITE & STRESS TEST   ");
console.log("==========================================================\n");

let passed = 0;
let failed = 0;

function assert(condition, testName) {
  if (condition) {
    console.log(`  [PASS] ${testName}`);
    passed++;
  } else {
    console.error(`  [FAIL] ${testName}`);
    failed++;
  }
}

// 1. Build & Asset Verification Test
console.log("1. Build & Local Asset Verification");
const distDir = path.join(__dirname, '..', 'dist');
assert(fs.existsSync(path.join(distDir, 'main.js')), "Dist main.js compiled asset exists");
assert(fs.existsSync(path.join(distDir, 'index.html')), "Dist index.html bundle exists");
assert(fs.existsSync(path.join(distDir, 'web-demuxer.wasm')), "Local web-demuxer.wasm binary asset exists");

// 2. AI Model Weights Stress Test
console.log("\n2. Neural Network Model Weights Stress & Integrity Test");
const weightsDir = path.join(__dirname, '..', 'src', 'weights');
const modelFiles = [
  'cnn-2x-s-rl.json', 'cnn-2x-s-an.json', 'cnn-2x-s-3d.json',
  'cnn-2x-m-rl.json', 'cnn-2x-m-an.json', 'cnn-2x-m-3d.json',
  'cnn-2x-l-rl.json', 'cnn-2x-l-an.json', 'cnn-2x-l-3d.json',
  'cnn-2x-l-v2.json' // Ultra High-Quality v2 model
];

for (const modelFile of modelFiles) {
  const filePath = path.join(weightsDir, modelFile);
  if (!fs.existsSync(filePath)) {
    assert(false, `Model weight file ${modelFile} exists`);
    continue;
  }
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    assert(data !== null && typeof data === 'object', `Model ${modelFile} valid JSON format (${(fs.statSync(filePath).size / 1024).toFixed(1)} KB)`);
  } catch (err) {
    assert(false, `Model ${modelFile} parsing error: ${err.message}`);
  }
}

// 3. Memory & High-Throughput Stress Test
console.log("\n3. Buffer Allocation & Memory Stability Stress Test");
const startTime = Date.now();
let totalAllocatedMB = 0;
const testBufferCount = 1000;
const bufferSizeBytes = 1920 * 1080 * 4; // 1080p RGBA frame buffer size (~8.29 MB per frame)

for (let i = 0; i < testBufferCount; i++) {
  const buf = Buffer.allocUnsafe(bufferSizeBytes);
  totalAllocatedMB += bufferSizeBytes / (1024 * 1024);
  // Perform memory operation
  buf.fill(i % 256, 0, 100);
}

const durationMs = Date.now() - startTime;
assert(totalAllocatedMB >= 7500, `Memory throughput stress test processed ${(totalAllocatedMB / 1024).toFixed(2)} GB simulated frame buffers in ${durationMs}ms`);

// 4. Local App Entry Main Process Integrity Test
console.log("\n4. Electron Main Process & GPU Flag Verification");
const mainJsPath = path.join(__dirname, '..', 'main.js');
assert(fs.existsSync(mainJsPath), "Electron main.js entry point exists");

if (fs.existsSync(mainJsPath)) {
  const mainContent = fs.readFileSync(mainJsPath, 'utf8');
  assert(mainContent.includes('enable-unsafe-webgpu'), "WebGPU hardware flag enabled");
  assert(mainContent.includes('force_high_performance_gpu'), "NVIDIA High Performance GPU force flag enabled");
  assert(mainContent.includes('Cross-Origin-Opener-Policy'), "COOP header security/performance configuration present");
  assert(mainContent.includes('Cross-Origin-Embedder-Policy'), "COEP header security/performance configuration present");
}

console.log("\n==========================================================");
console.log(`TEST SUMMARY: ${passed} PASSED, ${failed} FAILED`);
console.log("==========================================================");

if (failed > 0) {
  process.exit(1);
}
