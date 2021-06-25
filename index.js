const init = async () => {
  if (!navigator.gpu) {
    alert('webgpu not supported');
    return;
  }

  const adapter = await navigator.gpu.requestAdapter();
  const device = await adapter.requestDevice();

  const canvas = document.createElement('canvas');
  document.body.appendChild(canvas);
  
  // the WebGPU canvas context
  const ctx = canvas.getContext('gpupresent');
  const textureFormat = 'bgra8unorm'; 

  const onResize = () => {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;

    // call on resize to update display texture resolutions
    ctx.configure({
      device,
      format: textureFormat,
      // ?
      usage: GPUTextureUsage.OUTPUT_ATTACHMENT,
    });
  };
  onResize();
  window.addEventListener('resize', onResize, false);

  const testVertShader = /* wgsl */`
    // "declares an entry point by specifying its pipeline stage"
    [[stage(vertex)]]
    // applying the builtin(vertex_index) attribute to an entry point parameter takes the place of the magic gl_VertexID variable.
    // likewise, the builtin(position) attribute applied to the return type is like setting gl_Position.
    fn main([[builtin(vertex_index)]] vertexIndex : u32) -> [[builtin(position)]] vec4<f32> {
      var pos = array<vec2<f32>, 3>(
        vec2<f32>(0.0, 0.5),
        vec2<f32>(-0.5, -0.5),
        vec2<f32>(0.5, -0.5)
      );
      return vec4<f32>(pos[vertexIndex], 0.0, 1.0);
    }
  `;

  const testFragShader = /* wgsl */`
    [[stage(fragment)]]
    // kind of like in GL 4.x, we can write to location 0 to set the fragment color.
    fn main([[builtin(position)]] position: vec4<f32>) -> [[location(0)]] vec4<f32> {
      return vec4<f32>(position.rgb, 1.0);
    }
  `;

  // this is akin to a WebGL shader program; i.e. configures shaders for several GPU shader stages
  const renderPipeline = device.createRenderPipeline({
    vertex: {
      module: device.createShaderModule({
        code: testVertShader,
      }),
      entryPoint: 'main',
    },
    fragment: {
      module: device.createShaderModule({
        code: testFragShader,
      }),
      entryPoint: 'main',
      // ?
      targets: [{format: textureFormat}],
    },
    primitive: {
      // what geometric primitive(s) the vertices represent; same as GL
      topology: 'triangle-list',
    }
  });

  const frame = () => {
    requestAnimationFrame(frame);

    // the texture we should render to for this frame (i.e. not the one currently being displayed)
    const textureView = ctx.getCurrentTexture().createView();

    // a thing that encodes a list of commands to send to the GPU.
    // you can make multiple encoders to create several "command buffers", where everything in one command
    // buffer runs concurrently, but several command buffers submitted at once will run in sequence.
    const encoder = device.createCommandEncoder();

    // encode a render pass (as opposed to a compute pass)
    const renderEncoder = encoder.beginRenderPass({
      // you get a color attachment by default in GL (e.g. where gl_FragColor or location 0 goes), but they're also configurable in GL.
      colorAttachments: [
        {
          view: textureView, // the output texture for this color attachment
          // this is either 'load' or a color. If 'load', load the existing texture data into the render pass.
          // If a color, clear the texture to this color instead. This is preferred, because 'load' is expensive on some hardware.
          // This is like glClearColor.
          loadValue: {r: 0, g: 0, b: 0, a: 1},
          storeOp: 'store', // either 'store' or 'discard' (why?) the output
        }
      ]
    });
    renderEncoder.setPipeline(renderPipeline); // kind of like glUseProgram
    renderEncoder.draw(
      3, // vertex count
      1, // instance count
      0, // first vertex
      0, // first instance
    ); // just like glDrawArrays!
    renderEncoder.endPass();

    // send command buffers to the GPU!
    device.queue.submit([encoder.finish()]);
  };
  requestAnimationFrame(frame);
};

init();
