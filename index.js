const init = async () => {
  if (!navigator.gpu) {
    alert('webgpu not supported');
    return;
  }

  const adapter = await navigator.gpu.requestAdapter();
  const device = await adapter.requestDevice();

  const canvas = document.createElement('canvas');
  document.body.appendChild(canvas);

  const t0 = Date.now();
  
  // the WebGPU canvas context
  const ctx = canvas.getContext('gpupresent');
  const textureFormat = 'bgra8unorm'; 

  let width, height;
  const onResize = () => {
    width = window.innerWidth;
    height = window.innerHeight;
    canvas.width = width;
    canvas.height = height;

    // call configure on resize to update display texture resolutions
    // some older code uses configureSwapChain(); this replaces it.
    ctx.configure({
      device,
      format: textureFormat,
      // ?
      usage: GPUTextureUsage.OUTPUT_ATTACHMENT,
    });
  };
  onResize();
  window.addEventListener('resize', onResize, false);

  let mouseX = 0, mouseY = 0;
  window.addEventListener('pointermove', (event) => {
    mouseX = event.clientX;
    mouseY = event.clientY;
  }, false);

  const uniformsChunk = /* wgsl */`
    [[block]] struct Uniforms1 {
      resolution: vec2<f32>;
    };
    [[block]] struct Uniforms2 {
      mousePos: vec2<f32>;
    };
    [[block]] struct Uniforms3 {
      time: f32;
    };
    // we'll bind this during the render pass using setBindGroup()
    [[binding(0), group(0)]] var<uniform> uniforms1 : Uniforms1;
    [[binding(1), group(0)]] var<uniform> uniforms2 : Uniforms2;
    [[binding(2), group(0)]] var<uniform> uniforms3 : Uniforms3;
  `;

  const testVertShader = /* wgsl */`
    ${uniformsChunk}
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
      var offset = uniforms2.mousePos / uniforms1.resolution * vec2<f32>(2.0, -2.0);
      return vec4<f32>(vec2<f32>(-1.0, 1.0) + pos[vertexIndex] + offset, 0.0, 1.0);
    }
  `;

  const testFragShader = /* wgsl */`
    ${uniformsChunk}
    [[stage(fragment)]]
    // kind of like in GL 4.x, we can write to location 0 to set the fragment color.
    fn main([[builtin(position)]] position: vec4<f32>) -> [[location(0)]] vec4<f32> {
      return vec4<f32>(position.rg / uniforms1.resolution, sin(position.x * 0.1 + uniforms3.time * 10.1), 1.0);
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

  const createFloatUniform = (length) => {
    const size = length * 4;
    const dataBuffer = device.createBuffer({
      // COPY_DST mode means this buffer will be the target of buffer copy operations
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      size, // in bytes
    });

    // we need to create another buffer to store the data we want to copy into the uniform buffer.
    const uploadBuffer = device.createBuffer({
      size,
      // this will be the source for a buffer copy, and we can map it to host memory for writing.
      usage: GPUBufferUsage.COPY_SRC | GPUBufferUsage.MAP_WRITE,
    });

    const setData = async (encoder, data) => {
      // map upload buffer to host memory for writing
      await uploadBuffer.mapAsync(GPUMapMode.WRITE); 
      // put data in buffer
      new Float32Array(uploadBuffer.getMappedRange()).set(data); 
      // unmap the buffer from host memory, making it accessible to the GPU.
      uploadBuffer.unmap(); 

      encoder.copyBufferToBuffer(
        uploadBuffer, // src
        0, // offset
        dataBuffer, // dst
        0, // offset
        size, // length
      );
    };
    return {size, dataBuffer, uploadBuffer, setData};
  };

  const resolutionUniform = createFloatUniform(2);
  const mousePosUniform = createFloatUniform(2);
  const timeUniform = createFloatUniform(1);

  // a bind group for making the uniform available to the render pipeline
  const uniformBindGroup = device.createBindGroup({
    layout: renderPipeline.getBindGroupLayout(0),
    entries: [
      {
        binding: 0,
        resource: {
          buffer: resolutionUniform.dataBuffer,
          offset: 0,
          size: resolutionUniform.size,
        }
      },
      {
        binding: 1,
        resource: {
          buffer: mousePosUniform.dataBuffer,
          offset: 0,
          size: mousePosUniform.size,
        }
      },
      {
        binding: 2,
        resource: {
          buffer: timeUniform.dataBuffer,
          offset: 0,
          size: timeUniform.size,
        }
      }
    ]
  });

  const frame = async () => {
    // a thing that encodes a list of commands to send to the GPU.
    // you can make multiple encoders to create several "command buffers", where everything in one command
    // buffer runs concurrently, but several command buffers submitted at once will run in sequence.
    const encoder = device.createCommandEncoder();
    await Promise.all([
      resolutionUniform.setData(encoder, [width, height]),
      mousePosUniform.setData(encoder, [mouseX, mouseY]),
      timeUniform.setData(encoder, [(Date.now() - t0) / 1000]),
    ]);

    // the texture we should render to for this frame (i.e. not the one currently being displayed)
    const textureView = ctx.getCurrentTexture().createView();

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
    renderEncoder.setBindGroup(0, uniformBindGroup);
    renderEncoder.draw(
      3, // vertex count
      1, // instance count
      0, // first vertex
      0, // first instance
    ); // just like glDrawArrays!
    renderEncoder.endPass();

    // send command buffers to the GPU!
    device.queue.submit([encoder.finish()]);
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
};

init();
