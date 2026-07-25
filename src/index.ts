import Alpine from 'alpinejs';
import ImageCompare from './lib/image-compare-viewer.min';
import WebSR from '@websr/websr';
import type { WorkerRequestMessage, WorkerResponseMessage } from './types/worker-messages';

import 'bootstrap';
import 'bootstrap/dist/css/bootstrap.min.css';
import "./index.css";
import "./lib/image-compare-viewer.min.css";

const MAX_FILE_BLOB_SIZE=1900*1024*1024; //Just under 2GB, max ArrayBufferSize

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
let download_name: string;
let inputFileHandle: FileSystemFileHandle | undefined;
let inputFile: File;
let canvasesTransferred = false;
let gpu: any;
let websr: WebSR;

// AI model weights for different network sizes and content types
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

// Network name mapping
const networks: Record<NetworkSize, { name: string }> = {
    'small': {
        name: "anime4k/cnn-2x-s",
    },
    'medium': {
        name: "anime4k/cnn-2x-m",
    },
    'large': {
        name: "anime4k/cnn-2x-l",
    },
    'ultra': {
        name: "anime4k/cnn-2x-l",
    }
};

// Declare global window functions for Alpine to call and File System Access API
declare global {
    interface Window {
        chooseFile: (e?: Event) => Promise<void>;
        handleFileInput: (e: Event) => Promise<void>;
        initRecording: () => Promise<void>;
        fullScreenPreview: (e?: Event) => Promise<void>;
        switchNetworkSize: (el: HTMLInputElement) => Promise<void>;
        switchNetworkStyle: (el: HTMLInputElement) => Promise<void>;
        showSaveFilePicker: (options?: any) => Promise<FileSystemFileHandle>;
        showOpenFilePicker: (options?: any) => Promise<FileSystemFileHandle[]>;
        togglePause: () => void;
    }
}

document.addEventListener("DOMContentLoaded", index);

//===================  Initial Load ===========================

/**
 * Main initialization function called on page load
 */
async function index(): Promise<void> {
    Alpine.store('state', 'init');

    Alpine.start();
    document.body.style.display = "block";

    upscaled_canvas = document.getElementById("upscaled") as HTMLCanvasElement;
    original_canvas = document.getElementById('original') as HTMLCanvasElement;

    if (!("VideoEncoder" in window)) return showUnsupported("WebCodecs");

    setupDragAndDrop();

    worker.postMessage({ cmd: 'isSupported' } satisfies WorkerRequestMessage);

    window.chooseFile = chooseFile;
    window.handleFileInput = handleFileInput;
}

/**
 * Configure global drag and drop support for video files
 */
function setupDragAndDrop(): void {
    const dropZone = document.getElementById('file-load-panel') || document.body;

    window.addEventListener('dragover', (e: DragEvent) => {
        e.preventDefault();
        e.stopPropagation();
        if (dropZone) dropZone.classList.add('border-blue-600', 'bg-blue-50/50');
    });

    window.addEventListener('dragleave', (e: DragEvent) => {
        e.preventDefault();
        e.stopPropagation();
        if (dropZone) dropZone.classList.remove('border-blue-600', 'bg-blue-50/50');
    });

    window.addEventListener('drop', async (e: DragEvent) => {
        e.preventDefault();
        e.stopPropagation();
        if (dropZone) dropZone.classList.remove('border-blue-600', 'bg-blue-50/50');

        if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length > 0) {
            const droppedFile = e.dataTransfer.files[0];
            if (droppedFile.type.startsWith('video/') || droppedFile.name.match(/\.(mp4|mkv|mov|avi|webm|m4v)$/i)) {
                await loadVideo(droppedFile);
            }
        }
    });
}

/**
 * Show unsupported browser feature message
 */
function showUnsupported(text: string): void {
    Alpine.store('component', text);
    Alpine.store('state', 'unsupported');
}

/**
 * Prompt user to choose a video file using File System Access API or fallback file input
 */
async function chooseFile(e?: Event): Promise<void> {
    if (window.showOpenFilePicker) {
        try {
            const [fileHandle] = await window.showOpenFilePicker({
                types: [{
                    description: 'Video Files',
                    accept: {
                        'video/*': ['.mp4', '.mkv', '.mov', '.avi', '.webm', '.m4v']
                    }
                }],
                multiple: false
            });

            await loadVideo(fileHandle);
            return;
        } catch (err: any) {
            if (err.name === 'AbortError') return; // User cancelled
            console.warn('showOpenFilePicker failed or cancelled, falling back to input:', err);
        }
    }

    // Fallback to standard input element
    const fileInput = document.getElementById('file-input') as HTMLInputElement;
    if (fileInput) {
        fileInput.value = '';
        fileInput.click();
    }
}

/**
 * Handle selection from standard <input type="file"> element
 */
async function handleFileInput(e: Event): Promise<void> {
    const input = e.target as HTMLInputElement;
    if (input.files && input.files.length > 0) {
        await loadVideo(input.files[0]);
    }
}

//===================  Preview ===========================

/**
 * Load video file from FileSystemFileHandle or direct File object
 */
async function loadVideo(fileOrHandle: FileSystemFileHandle | File): Promise<void> {
    Alpine.store('state', 'loading');

    if ('getFile' in fileOrHandle && typeof (fileOrHandle as any).getFile === 'function') {
        inputFileHandle = fileOrHandle as FileSystemFileHandle;
        inputFile = await (fileOrHandle as FileSystemFileHandle).getFile();
    } else {
        inputFileHandle = undefined;
        inputFile = fileOrHandle as File;
    }

    download_name = inputFile.name.split(".")[0] + "-upscaled.mp4";
    Alpine.store('download_name', download_name);
    Alpine.store('filename', inputFile.name);

    await setupPreview(inputFile);
}

/**
 * Set up the preview UI with before/after comparison
 */
async function setupPreview(file: File): Promise<void> {
    video = document.createElement('video');
    video.preload = 'auto';

    video.onerror = (e) => {
        console.error('Video load error:', e);
        showError('Failed to load video file. Please ensure it is a supported video format.');
    };

    const imageCompare = document.getElementById('image-compare-outer') as HTMLElement;

    let hasLoaded = false;
    const onVideoReady = async function () {
        if (hasLoaded || !video.videoWidth || !video.videoHeight) return;
        hasLoaded = true;

        Alpine.store('width', video.videoWidth);
        Alpine.store('height', video.videoHeight);

        if (!canvasesTransferred) {
            upscaled_canvas.width = video.videoWidth * 2;
            upscaled_canvas.height = video.videoHeight * 2;
            original_canvas.width = video.videoWidth * 2;
            original_canvas.height = video.videoHeight * 2;
        }

        imageCompare.style.height = '318px';
        imageCompare.style.width = `${Math.round(video.videoWidth / video.videoHeight * 318)}px`;
        imageCompare.style.margin = 'auto';
        imageCompare.style.position = 'relative';

        try {
            new ImageCompare(document.getElementById('image-compare')).mount();
        } catch (e) {
            // Already mounted
        }

        video.currentTime = (isFinite(video.duration) && video.duration > 0) ? video.duration * 0.2 : 0;

        const triggerPreview = () => {
            if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(showPreview);
            else requestAnimationFrame(showPreview);
        };

        if (video.seeking) {
            video.onseeked = triggerPreview;
        } else {
            triggerPreview();
        }

        window.togglePause = function () {
            const currentState = Alpine.store('state');
            if (currentState === 'processing') {
                worker.postMessage({ cmd: 'pause' } satisfies WorkerRequestMessage);
            } else if (currentState === 'paused') {
                worker.postMessage({ cmd: 'resume' } satisfies WorkerRequestMessage);
            }
        };
    };

    video.onloadeddata = onVideoReady;
    video.onloadedmetadata = onVideoReady;

    video.src = URL.createObjectURL(file);
    video.load();

    if (video.readyState >= 1) {
        onVideoReady();
    }

    async function showPreview() {
        try {
            window.initRecording = initRecording;
            window.fullScreenPreview = fullScreenPreview;

            const bitmap = await createImageBitmap(video);

            if (!canvasesTransferred) {
                const upscaled = upscaled_canvas.transferControlToOffscreen();
                const original = original_canvas.transferControlToOffscreen();
                canvasesTransferred = true;

                worker.postMessage({
                    cmd: "init",
                    data: {
                        bitmap,
                        upscaled,
                        original,
                        resolution: {
                            width: video.videoWidth,
                            height: video.videoHeight
                        }
                    }
                }, [bitmap, upscaled, original]);
            } else {
                worker.postMessage({
                    cmd: "init",
                    data: {
                        bitmap,
                        resolution: {
                            width: video.videoWidth,
                            height: video.videoHeight
                        }
                    }
                }, [bitmap]);
            }

            content = 'rl';
            await updateNetwork();
            Alpine.store('style', 'rl');
            Alpine.store('state', 'preview');
        } catch (err: any) {
            console.error('showPreview error:', err);
            showError('Failed to generate video preview: ' + (err?.message || err));
        }
    }









        function setFullScreenLocation(){
            const fullScreenButton = document.getElementById('full-screen');
            if (!fullScreenButton) return;
            const containerWidth = Math.round(video.videoWidth/video.videoHeight*318);
            const containerHeight = 318;
            
            // Position at bottom-right of the preview container (with small padding)
            fullScreenButton.style.left = `${imageCompare.offsetLeft + containerWidth - 20}px`;
            fullScreenButton.style.top = `${imageCompare.offsetTop + containerHeight - 20}px`;
        }

        setTimeout(setFullScreenLocation, 20);
        setTimeout(setFullScreenLocation, 60);
        setTimeout(setFullScreenLocation, 200);





        imageCompare.addEventListener('fullscreenchange', function () {
            if(!document.fullscreenElement){
                // Reset canvas styles
                upscaled_canvas.style.width = ``;
                upscaled_canvas.style.height = ``;
                original_canvas.style.width = ``;
                original_canvas.style.height = ``;
                
                // Reset container styles to original preview dimensions
                const imageCompareOuter = document.getElementById('image-compare-outer');
                const imageCompareInner = document.getElementById('image-compare');
                
                // Reset outer container
                imageCompareOuter.style.width = ``;
                imageCompareOuter.style.height = ``;
                imageCompareOuter.style.backgroundColor = ``;
                imageCompareOuter.style.display = ``;
                imageCompareOuter.style.justifyContent = ``;
                imageCompareOuter.style.alignItems = ``;
                
                // Reset inner container to original preview size
                imageCompareInner.style.height = '318px';
                imageCompareInner.style.width = `${Math.round(video.videoWidth/video.videoHeight*318)}px`;
                imageCompareInner.style.margin = 'auto';
                imageCompareInner.style.position = 'relative';
            }
        });

        let bitrate = getBitrate();

        const estimated_size = (bitrate/8)*video.duration + (128/8)*video.duration; // Assume 128 kbps audio

        if(estimated_size > MAX_FILE_BLOB_SIZE){
            Alpine.store('target', 'writer');
        } else {
            Alpine.store('target', 'blob');
            const estimate = await navigator.storage.estimate();
            if (estimate.quota && estimated_size > estimate.quota) {
                Alpine.store('target', 'writer');
            }
        }

        Alpine.store('size', humanFileSize(estimated_size));


        function canvasFullScreen(){
            // Calculate aspect ratios
            const videoAspectRatio = video.videoWidth / video.videoHeight;
            const screenAspectRatio = window.innerWidth / window.innerHeight;
            
            let displayWidth, displayHeight;

            const imageCompareOuter = document.getElementById('image-compare-outer');
            const imageCompareInner = document.getElementById('image-compare');
            
            // If video is wider than screen, fit to width (letterbox on top/bottom)
            if (videoAspectRatio > screenAspectRatio) {
                displayWidth = window.innerWidth;
                displayHeight = window.innerWidth / videoAspectRatio;
            } 
            // If video is taller than screen, fit to height (pillarbox on sides)
            else {
                displayWidth = window.innerHeight * videoAspectRatio;
                displayHeight = window.innerHeight;
            }
            
            // Style the outer container to fill screen with black background and center content
            imageCompareOuter.style.width = `${window.innerWidth}px`;
            imageCompareOuter.style.height = `${window.innerHeight}px`;
            imageCompareOuter.style.backgroundColor = 'black';
            imageCompareOuter.style.display = 'flex';
            imageCompareOuter.style.justifyContent = 'center';
            imageCompareOuter.style.alignItems = 'center';
            

            console.log("Image Compare Outer", imageCompareOuter);
            console.log("Image Compare Inner", imageCompareInner);
            // Size the inner container to maintain aspect ratio
            imageCompareInner.style.width = `${displayWidth}px`;
            imageCompareInner.style.height = `${displayHeight}px`;
            
            // Let the canvases fill their parent container
            upscaled_canvas.style.width = `${displayWidth}px`;
            upscaled_canvas.style.height = `${displayHeight}px`;
            original_canvas.style.width = `${displayWidth}px`;
            original_canvas.style.height = `${displayHeight}px`;
        }

        async function fullScreenPreview(e?: Event) {
            imageCompare.requestFullscreen();
            setTimeout(canvasFullScreen, 20);
            setTimeout(canvasFullScreen, 60);
            setTimeout(canvasFullScreen, 200);
        }

        Alpine.store('state', 'preview');

        window.switchNetworkSize = async function(el: HTMLInputElement){
            if(el.value !== size){
                size = el.value as NetworkSize;

                await updateNetwork();
            }
        }

        window.switchNetworkStyle = async function(el: HTMLInputElement){
            if(el.value !== content){
                content = el.value as ContentType;

                await updateNetwork();
            }
        }
    }


/**
 * Handle messages from the video processing worker
 */
worker.onmessage = function (event: MessageEvent<WorkerResponseMessage>) {
    if (event.data.cmd === 'isSupported') {
        const supported = event.data.data;

        if (!supported) return showUnsupported("WebGPU");

    } else if (event.data.cmd === 'progress') {
        Alpine.store('progress', event.data.data);
        if (Alpine.store('state') !== 'paused') {
            Alpine.store('state', 'processing');
        }

    } else if (event.data.cmd === 'process') {
        // Processing started

    } else if (event.data.cmd === 'error') {
        showError(event.data.data);

    } else if (event.data.cmd === 'eta') {
        Alpine.store('eta', event.data.data);

    } else if (event.data.cmd === 'finished') {
        Alpine.store('state', 'complete');
        Alpine.store('download_url', event.data.data ? window.URL.createObjectURL(event.data.data) : null);
    }
    else if (event.data.cmd === 'paused') {
        Alpine.store('state', 'paused');
    } else if (event.data.cmd === 'resumed') {
        Alpine.store('state', 'processing');
    }
};



/**
 * Switch to a different upscaling network
 */
async function updateNetwork(): Promise<void> {
    const bitmap = await createImageBitmap(video);

    worker.postMessage({
        cmd: 'network',
        data: {
            name: networks[size].name,
            bitmap,
            weights: weights[size][content]
        }
    } satisfies WorkerRequestMessage);
}

//===================  Process ===========================

/**
 * Start the video upscaling process
 */
async function initRecording(): Promise<void> {
    Alpine.store('state', 'loading');

    let bitrate = getBitrate();
    const estimated_size = (bitrate / 8) * video.duration + (128 / 8) * video.duration; // Assume 128 kbps audio

    let outputHandle: FileSystemFileHandle | undefined;

    // Max Blob size - 10 MB (for testing, should be much higher in production)
    if (estimated_size > MAX_FILE_BLOB_SIZE) {
        try {
            outputHandle = await showFilePicker();
        } catch (e) {
            console.warn("User aborted request");
            return Alpine.store('state', 'preview');
        }
    }

    worker.postMessage({
        cmd: "process",
        inputHandle: inputFileHandle || inputFile,
        outputHandle
    } satisfies WorkerRequestMessage);
}

/**
 * Display error message to user
 */
function showError(message: string): void {
    Alpine.store('state', 'error');
    Alpine.store('error', message);
}

/**
 * Calculate target bitrate based on video resolution
 */
function getBitrate(): number {
    return 5e6 * Math.sqrt((video.videoWidth * video.videoHeight * 4) / (1280 * 720));
}

/**
 * Format bytes into human-readable file size
 */
function humanFileSize(bytes: number, si: boolean = false, dp: number = 1): string {
    const thresh = si ? 1000 : 1024;

    if (Math.abs(bytes) < thresh) {
        return bytes + ' B';
    }

    const units = si
        ? ['kB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB']
        : ['KiB', 'MiB', 'GiB', 'TiB', 'PiB', 'EiB', 'ZiB', 'YiB'];
    let u = -1;
    const r = 10 ** dp;

    do {
        bytes /= thresh;
        ++u;
    } while (Math.round(Math.abs(bytes) * r) / r >= thresh && u < units.length - 1);

    return bytes.toFixed(dp) + ' ' + units[u];
}

/**
 * Show native file picker for saving output video
 */
async function showFilePicker(): Promise<FileSystemFileHandle> {
    const handle = await window.showSaveFilePicker({
        startIn: 'downloads',
        suggestedName: download_name,
        types: [{
            description: 'Video File',
            accept: { 'video/mp4': ['.mp4'] }
        }],
    });

    return handle;
}












