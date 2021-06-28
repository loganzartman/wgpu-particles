export const getWebgpuContext = (canvas) => {
  let ctx = null;
  if (ctx = canvas.getContext('gpupresent')) {
    return ctx;
  }
  // safari
  if (ctx = canvas.getContext('gpu')) {
    return ctx;
  }
  return ctx;
};

/*
 * Polyfills context.configure() for browsers that support context.configureSwapChain().
 */
const polyfillContextConfigure = () => {
  const Context = GPUCanvasContext;
  if (typeof Context === 'undefined') {
    return;
  }
  if (typeof Context.prototype.configure !== 'undefined') {
    return;
  }

  let swapChain = null;
  Context.prototype.configure = function configure(...args) {
    swapChain = this.configureSwapChain(...args);
  };
  Context.prototype.getCurrentTexture = function getCurrentTexture(...args) { 
    return swapChain.getCurrentTexture(...args);
  };
};

/*
 * Polyfills mapAsync() and getMappedRange() for Safari.
 * Note that mappedAtCreation isn't polyfilled, because it must be synchronous.
 */
const polyfillMapAsync = () => {
  if (typeof GPUBuffer === 'undefined') {
    return;
  }
  if (typeof GPUBuffer.prototype.mapAsync !== 'undefined') {
    return;
  }
  if (typeof GPUBuffer.prototype.mapWriteAsync === 'undefined') {
    return; // polyfill not supported
  }

  if (typeof GPUMapMode === 'undefined') {
    window.GPUMapMode = {
      READ: 0x0001,
      WRITE: 0x0002,
    };
  }
  
  GPUBuffer.prototype.mapAsync = async function mapAsync(...args) {
    const [mode, ...rest] = args;
    let buffer = null;
    if (mode & GPUMapMode.WRITE) {
      buffer = await this.mapWriteAsync(...rest);
    }
    else if (mode & GPUMapMode.READ) {
      buffer = await this.mapReadAsync(...rest);
    }
    else {
      throw new Error('Invalid mode');
    }
    this.__polyfill_buffer = buffer;
    return undefined;
  };
  GPUBuffer.prototype.getMappedRange = function getMappedRange(offset=0, length=undefined) {
    if (typeof length === 'undefined') {
      length = this.__polyfill_buffer.length;
    }
    // don't want to copy the underlying array, but still support casting to other typed arrays.
    // can't do this with DataView
    return new Uint8Array(this.__polyfill_buffer, offset, length);
  };
};

const polyfillCreateRenderPipeline = () => {
  if (typeof GPUDevice?.prototype?.createRenderPipeline === 'undefined') {
    return;
  }
  const createRenderPipeline = GPUDevice.prototype.createRenderPipeline;
  GPUDevice.prototype.createRenderPipeline = function(descriptor) {
    const newDescriptor = Object.assign({}, descriptor);

    if (navigator.userAgent.includes('Safari')) {
      const topology = newDescriptor.primitive?.topology;
      if (topology) {
        newDescriptor.primitiveTopology = topology;
        delete newDescriptor.primitive;
      }

      const targets = newDescriptor.fragment?.targets;
      if (targets) {
        const newTargets = {
          alphaBlend: {srcFactor: 'one', dstFactor: 'zero', operation: 'add'},
          colorBlend: {srcFactor: 'one', dstFactor: 'zero', operation: 'add'},
          writeMask: GPUColorWrite.ALL,
          ...targets,
        };
        newDescriptor.colorStates = newTargets;
        delete newDescriptor.fragment.targets;
      }

      const stages = ["vertex", "fragment"];
      stages.forEach((stage) => {
        if (newDescriptor[stage]) {
          newDescriptor[`${stage}Stage`] = newDescriptor[stage];
          delete newDescriptor[stage];
        }
      });
    }

    return createRenderPipeline.call(this, newDescriptor);
  };
};

export const polyfillWebgpu = () => {
  polyfillContextConfigure();
  polyfillMapAsync();
  polyfillCreateRenderPipeline();
};
