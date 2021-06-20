const init = async () => {
  if (!navigator.gpu) {
    alert('webgpu not supported');
    return;
  }

  const adapter = await navigator.gpu.requestAdapter();
  const device = await adapter.requestDevice();

  const canvas = document.createElement('canvas');
  document.body.appendChild(canvas);

  const ctx = canvas.getContext('gpupresent');

  const swapChain = ctx.configureSwapChain({
    device,
    format: 'bgra8norm',
    usage: GPUTextureUsage.OUTPUT_ATTACHMENT,
  });
};

init();