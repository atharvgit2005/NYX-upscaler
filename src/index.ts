import Alpine from 'alpinejs';
import ImageCompare from './lib/image-compare-viewer.min';
import WebSR from '@websr/websr';
import type { WorkerRequestMessage, WorkerResponseMessage } from './types/worker-messages';

import 'bootstrap';
import 'bootstrap/dist/css/bootstrap.min.css';
import "./index.css";
import "./lib/image-compare-viewer.min.css";

const MAX_FILE_BLOB_SIZE = 1900 * 1024 * 1024; // ~2GB max Blob allocation

// Web Worker for video processing
const worker = new Worker(new URL('./worker.ts', import.meta.url));

// Canvas and video elements
let upscaled_canvas: HTMLCanvasElement;
let original_canvas: HTMLCanvasElement;
let video: HTMLVideoElement;

// Network selection
type NetworkSize = 'small' | 'medium' | 'large' | 'ultra';
type ContentType = 'rl' | 'an' | '3d';

let size: NetworkSize = 'medium';
let content: ContentType = 'rl';

// Video data
let download_name: string = 'upscaled.mp4';
let inputFileHandle: FileSystemFileHandle | undefined;
let inputFile: File;
let canvasesTransferred = false;
let gpu: any;
let websr: WebSR;

// AI model weights
type WeightsMap = {
    [K in NetworkSize]: {
        [C in ContentType]: any;
    };
};

const weights: WeightsMap = {
    'ultra': {
        'rl': require('./weights/cnn-2x-l-v2.json'),
        'an': require('./weights/cnn-2x-l-v2.json'),
        '3d': require('./weights/cnn-2x-l-v2.json'),
    },
    'large': {
        'rl': require('./weights/cnn-2x-l-rl.json'),
        'an': require('./weights/cnn-2x-l-an.json'),
        '3d': require('./weights/cnn-2x-l-3d.json'),
    },
    'medium': {
        'rl': require('./weights/cnn-2x-m-rl.json'),
        'an': require('./weights/cnn-2x-m-an.json'),
        '3d': require('./weights/cnn-2x-m-3d.json'),
    },
    'small': {
        'rl': require('./weights/cnn-2x-s-rl.json'),
        'an': require('./weights/cnn-2x-s-an.json'),
        '3d': require('./weights/cnn-2x-s-3d.json'),
    }
};

const networks: Record<NetworkSize, { name: string }> = {
    'small': { name: "anime4k/cnn-2x-s" },
    'medium': { name: "anime4k/cnn-2x-m" },
    'large': { name: "anime4k/cnn-2x-l" },
    'ultra': { name: "anime4k/cnn-2x-l" }
};

// Global Window interface
declare global {
    interface Window {
        chooseFile: (e?: Event) => Promise<void>;
        handleFileInput: (e: Event) => Promise<void>;
        initRecording: () => Promise<void>;
        switchModel: (modelName: NetworkSize) => Promise<void>;
        showSaveFilePicker: (options?: any) => Promise<FileSystemFileHandle>;
        showOpenFilePicker: (options?: any) => Promise<FileSystemFileHandle[]>;
        togglePause: () => void;
    }
}

document.addEventListener("DOMContentLoaded", index);

/**
 * Main initialization function
 */
async function index(): Promise<void> {
    // Single Reactive Object Store for Alpine v3
    Alpine.store('app', {
        state: 'init',
        progress: 0,
        eta: 'calculating...',
        filename: '',
        width: 0,
        height: 0,
        error: '',
        download_url: '',
        download_name: 'upscaled.mp4',
        network: 'medium'
    });

    Alpine.start();
    document.body.style.display = "block";

    upscaled_canvas = document.getElementById("upscaled") as HTMLCanvasElement;
    original_canvas = document.getElementById('original') as HTMLCanvasElement;

    if (!("VideoEncoder" in window)) {
        (Alpine.store('app') as any).state = 'unsupported';
        (Alpine.store('app') as any).error = 'WebCodecs';
        return;
    }

    setupDragAndDrop();

    worker.postMessage({ cmd: 'isSupported' } satisfies WorkerRequestMessage);

    window.chooseFile = chooseFile;
    window.handleFileInput = handleFileInput;
    window.initRecording = initRecording;
    window.switchModel = switchModel;
    window.togglePause = togglePause;

    // Check for Electron Auto-Input CLI
    if ((window as any).electronAPI && typeof (window as any).electronAPI.getAutoInput === 'function') {
        (window as any).electronAPI.getAutoInput().then(async (autoPath: string | null) => {
            console.log('[AUTO-INPUT]', autoPath);
            if (autoPath) {
                const res = await (window as any).electronAPI.readLocalFile(autoPath);
                if (res && res.buffer) {
                    const file = new File([res.buffer], res.name, { type: 'video/mp4' });
                    await loadVideo(file);
                    setTimeout(() => initRecording(), 1500);
                }
            }
        });
    }
}

/**
 * Handle worker message responses
 */
worker.onmessage = function (event: MessageEvent<WorkerResponseMessage>) {
    const app = Alpine.store('app') as any;

    if (event.data.cmd === 'isSupported') {
        if (!event.data.data) {
            app.state = 'unsupported';
            app.error = 'WebGPU';
        }
    } else if (event.data.cmd === 'progress') {
        app.progress = Math.round(event.data.data);
        if (app.state !== 'paused' && app.state !== 'complete') {
            app.state = 'processing';
        }
    } else if (event.data.cmd === 'eta') {
        app.eta = event.data.data;
    } else if (event.data.cmd === 'finished') {
        app.state = 'complete';
        app.progress = 100;
        const blob = event.data.data;
        if (blob) {
            app.download_url = window.URL.createObjectURL(blob);
            if ((window as any).electronAPI && typeof (window as any).electronAPI.saveFile === 'function') {
                blob.arrayBuffer().then((buf: ArrayBuffer) => {
                    const name = app.download_name || 'upscaled.mp4';
                    const savePath = 'C:\\Users\\Atharv Paharia\\OneDrive\\Desktop\\upscaler\\' + name;
                    (window as any).electronAPI.saveFile(savePath, buf);
                });
            }
        }
    } else if (event.data.cmd === 'error') {
        app.state = 'error';
        app.error = event.data.data;
    } else if (event.data.cmd === 'paused') {
        app.state = 'paused';
    } else if (event.data.cmd === 'resumed') {
        app.state = 'processing';
    }
};

/**
 * Drag and Drop setup
 */
function setupDragAndDrop(): void {
    const dropzone = document.body;

    dropzone.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.stopPropagation();
    });

    dropzone.addEventListener('drop', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]) {
            loadVideo(e.dataTransfer.files[0]);
        }
    });
}

/**
 * File selection handlers
 */
async function chooseFile(e?: Event): Promise<void> {
    if (e) e.stopPropagation();
    try {
        if ('showOpenFilePicker' in window) {
            const [handle] = await window.showOpenFilePicker({
                types: [{ description: 'Video Files', accept: { 'video/*': ['.mp4', '.mkv', '.mov', '.avi', '.webm'] } }]
            });
            inputFileHandle = handle;
            const file = await handle.getFile();
            await loadVideo(file);
        } else {
            const input = document.getElementById('file-input') as HTMLInputElement;
            input.click();
        }
    } catch (err) {
        console.log('File selection cancelled');
    }
}

async function handleFileInput(e: Event): Promise<void> {
    const target = e.target as HTMLInputElement;
    if (target.files && target.files[0]) {
        await loadVideo(target.files[0]);
    }
}

/**
 * Load and setup video for processing
 */
async function loadVideo(file: File): Promise<void> {
    inputFile = file;
    const app = Alpine.store('app') as any;
    app.state = 'loading';
    app.filename = file.name;

    const parts = file.name.split('.');
    const ext = parts.pop() || 'mp4';
    download_name = `${parts.join('.')}_upscaled.${ext}`;
    app.download_name = download_name;

    if (video) {
        video.pause();
        video.src = '';
        video.load();
    }

    video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';
    video.src = URL.createObjectURL(file);

    await new Promise<void>((resolve) => {
        video.onloadedmetadata = () => resolve();
    });

    app.width = video.videoWidth;
    app.height = video.videoHeight;

    const targetTime = (isFinite(video.duration) && video.duration > 0) ? video.duration * 0.1 : 0;
    video.currentTime = targetTime;

    await new Promise<void>((resolve) => {
        let resolved = false;
        const done = () => { if (!resolved) { resolved = true; resolve(); } };
        video.onseeked = done;
        setTimeout(done, 500);
    });

    await new Promise<void>((resolve) => {
        requestAnimationFrame(() => {
            requestAnimationFrame(() => resolve());
        });
    });

    await setupPreview();
    app.state = 'preview';
}

/**
 * Setup preview canvases and WebSR instance
 */
async function setupPreview(): Promise<void> {
    const bitmap = await createImageBitmap(video);

    if (!canvasesTransferred) {
        canvasesTransferred = true;
        const offscreenUpscaled = upscaled_canvas.transferControlToOffscreen();
        const offscreenOriginal = original_canvas.transferControlToOffscreen();

        worker.postMessage({
            cmd: 'init',
            data: {
                upscaled: offscreenUpscaled,
                original: offscreenOriginal,
                bitmap,
                resolution: { width: video.videoWidth, height: video.videoHeight }
            }
        }, [offscreenUpscaled, offscreenOriginal, bitmap]);
    } else {
        worker.postMessage({
            cmd: 'network',
            data: {
                name: networks[size].name,
                bitmap,
                weights: weights[size][content]
            }
        }, [bitmap]);
    }

    setTimeout(() => {
        const element = document.getElementById('image-compare');
        if (element) {
            element.innerHTML = '';
            element.appendChild(original_canvas);
            element.appendChild(upscaled_canvas);
            new ImageCompare(element, { controlColor: '#06b6d4' }).mount();
        }
    }, 100);
}

/**
 * Switch AI neural model size
 */
async function switchModel(modelName: NetworkSize): Promise<void> {
    size = modelName;
    const app = Alpine.store('app') as any;
    app.network = modelName;

    if (video && video.videoWidth) {
        const bitmap = await createImageBitmap(video);
        worker.postMessage({
            cmd: 'network',
            data: {
                name: networks[size].name,
                bitmap,
                weights: weights[size][content]
            }
        }, [bitmap]);
    }
}

/**
 * Start upscaling process
 */
async function initRecording(): Promise<void> {
    const app = Alpine.store('app') as any;
    app.state = 'processing';
    app.progress = 0;
    app.eta = 'calculating...';

    worker.postMessage({
        cmd: "process",
        inputHandle: inputFileHandle || inputFile,
        outputHandle: undefined
    } satisfies WorkerRequestMessage);
}

/**
 * Toggle Pause / Resume
 */
function togglePause(): void {
    const app = Alpine.store('app') as any;
    if (app.state === 'paused') {
        worker.postMessage({ cmd: 'resume' });
    } else {
        worker.postMessage({ cmd: 'pause' });
    }
}
