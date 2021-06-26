import getUtils from './util.js';

const init = async () => {
  if (!navigator.gpu) {
    alert('webgpu not supported');
    return;
  }

  const adapter = await navigator.gpu.requestAdapter();
  const device = await adapter.requestDevice();
  const utils = getUtils({device});

  const canvas = document.createElement('canvas');
  document.body.appendChild(canvas);

  const t0 = Date.now();
  let counter = 0;
  
  // the WebGPU canvas context
  const ctx = canvas.getContext('gpupresent');
  const textureFormat = 'bgra8unorm'; 

  let width, height;
  const onResize = () => {
    width = Math.ceil(window.innerWidth * window.devicePixelRatio);
    height = Math.ceil(window.innerHeight * window.devicePixelRatio);
    canvas.width = width;
    canvas.height = height;
    canvas.style.width = `${window.innerWidth}px`;
    canvas.style.height = `${window.innerHeight}px`;

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
  let mousePx = 0, mousePy = 0;
  window.addEventListener('pointermove', (event) => {
    mouseX = event.clientX * window.devicePixelRatio;
    mouseY = event.clientY * window.devicePixelRatio;
  }, false);

  const uniforms = utils.createUniforms(
    {
      resolution: {length: 2},
      mousePos: {length: 2},
      mousePrevPos: {length: 2},
      time: {length: 1},
      counter: {length: 1},
      nParticles: {length: 1},
    }, 
    {ArrayType: Float32Array},
  );

  const uniformsChunk = /* wgsl */`
    [[block]] struct Uniforms {
      resolution: vec2<f32>;
      mousePos: vec2<f32>;
      mousePrevPos: vec2<f32>;
      time: f32;
      counter: f32;
      nParticles: f32;
    };
    // we'll bind this during the render pass using setBindGroup()
    [[binding(0), group(0)]] var<uniform> uniforms : Uniforms;
  `;

  const utilChunk = /* wgsl */`
    fn hsv2rgb(c: vec3<f32>) -> vec3<f32> {
      var K = vec4<f32>(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);
      var p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
      return c.z * mix(K.xxx, clamp(p - K.xxx, vec3<f32>(0.0), vec3<f32>(1.0)), vec3<f32>(c.y));
    }

    fn rand(n: f32) -> f32 {
      return fract(sin(n) * 43758.5453123);
    }
    fn randrange(n: f32, lo: f32, hi: f32) -> f32 {
      return rand(n) * (hi - lo) + lo;
    }
  `;

  // create initial data for particles
  const nParticles = 100000;
  const nParticleProps = 4;
  const initialParticleData = new Float32Array(nParticles * nParticleProps);
  for (let i = 0; i < nParticles; ++i) {
    const offset = i * nParticleProps;
    initialParticleData[offset + 0] = Math.random(); // x
    initialParticleData[offset + 1] = Math.random(); // y
    initialParticleData[offset + 2] = Math.random() * 0.001; // dx
    initialParticleData[offset + 3] = -Math.random() * 0.005; // dy
  }
  // create particle data storage buffer and load initial data
  const particlesBuffer = device.createBuffer({
    size: initialParticleData.byteLength,
    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.STORAGE,
    mappedAtCreation: true,
  });
  new Float32Array(particlesBuffer.getMappedRange()).set(initialParticleData);
  particlesBuffer.unmap();

  const triangleShader = /* wgsl */`
    ${uniformsChunk}
    ${utilChunk}

    struct VertexOutput {
      [[builtin(position)]] position : vec4<f32>;
      // like in GL, stage outputs/inputs only need to be defined in the shader
      [[location(0)]] color : vec4<f32>;
    };

    // "declares an entry point by specifying its pipeline stage"
    [[stage(vertex)]]
    // applying the builtin(vertex_index) attribute to an entry point parameter takes the place of the magic gl_VertexID variable.
    // likewise, the builtin(position) attribute applied to the return type is like setting gl_Position.
    fn vert_main(
      [[builtin(vertex_index)]] vertexIndex : u32,
      [[builtin(instance_index)]] instanceIndex: u32,
      [[location(0)]] particlePos: vec2<f32>,
      [[location(1)]] particleVel: vec2<f32>,
    ) -> VertexOutput {
      var scale = vec2<f32>(0.0025, length(particleVel) * 5.0);
      var vertexCoords = array<vec2<f32>, 3>(
        vec2<f32>(0.0, -0.5),
        vec2<f32>(0.5, 0.5),
        vec2<f32>(-0.5, 0.5)
      );
      var vertex = vertexCoords[vertexIndex];
      var center = particlePos * vec2<f32>(2.0, -2.0);
      var angle = atan2(particleVel.x, particleVel.y);
      var pos = vec2<f32>(
        (vertex.x * scale.x * cos(angle)) - (vertex.y * scale.y * sin(angle)),
        (vertex.x * scale.x * sin(angle)) + (vertex.y * scale.y * cos(angle))
      );
      var output : VertexOutput;
      output.position = vec4<f32>(vec2<f32>(-1.0, 1.0) + center + pos, 0.0, 1.0);
      output.color = vec4<f32>(hsv2rgb(vec3<f32>(f32(instanceIndex) / uniforms.nParticles, randrange(f32(instanceIndex), 0.3, 0.7), 0.5)), 1.0);
      return output;
    }

    [[stage(fragment)]]
    // kind of like in GL 4.x, we can write to location 0 to set the fragment color.
    fn frag_main(
      [[location(0)]] color : vec4<f32>,
    ) -> [[location(0)]] vec4<f32> {
      return color;
    }
  `;
  const triangleModule = device.createShaderModule({code: triangleShader});

  // this is akin to a WebGL shader program; i.e. configures shaders for several GPU shader stages
  const renderPipeline = device.createRenderPipeline({
    vertex: {
      module: triangleModule,
      entryPoint: 'vert_main',
      buffers: [
        // configure attributes derived from first vertex buffer
        {
          // instanced particles
          arrayStride: nParticleProps * 4,
          stepMode: 'instance',
          attributes: [
            {
              // x, y
              shaderLocation: 0,
              offset: 0,
              format: 'float32x2',
            },
            {
              // dx, dy
              shaderLocation: 1,
              offset: 2 * 4,
              format: 'float32x2',
            },
          ],
        },
      ],
    },
    fragment: {
      module: triangleModule,
      entryPoint: 'frag_main',
      // ?
      targets: [{format: textureFormat}],
    },
    primitive: {
      // what geometric primitive(s) the vertices represent; same as GL
      topology: 'triangle-list',
    }
  });

  const updateParticlesShader = /* wgsl */`
    ${uniformsChunk}
    ${utilChunk}

    struct Particle {
      pos : vec2<f32>;
      vel : vec2<f32>;
    };
    [[block]] struct Particles {
      particles : [[stride(16)]] array<Particle>;
    };
    [[binding(1), group(0)]] var<storage, read_write> particles : Particles;

    [[stage(compute), workgroup_size(1)]]
    fn main([[builtin(global_invocation_id)]] globalInvocationId : vec3<u32>) {
      var index = globalInvocationId.x;
      var pos = particles.particles[index].pos;
      var vel = particles.particles[index].vel;
      particles.particles[index].pos = pos + vel;
      particles.particles[index].vel.y = vel.y + 0.0005;

      var n = 1000.0;
      var counterDiff = f32(index) - (uniforms.counter * n) % uniforms.nParticles;
      if (0.0 < counterDiff && counterDiff < n) {
        var posA = uniforms.mousePrevPos / uniforms.resolution;
        var posB = uniforms.mousePos / uniforms.resolution;
        var randomMag = 0.0005 + 0.04 * length(posB - posA);
        var f = counterDiff / n;
        var discAngle = randrange(f32(index) * 2.0, 0.0, 6.28);
        var discLen = randrange(f32(index) * 2.0 + 1.0, 0.0, 0.05);
        var disc = vec2<f32>(cos(discAngle) * discLen, sin(discAngle) * discLen);
        particles.particles[index].pos = disc + posA * (1.0 - f) + posB * f;
        particles.particles[index].vel = (posB - posA) * 0.2 + vec2<f32>(
          randrange(f32(index) * 2.0, -randomMag, randomMag),
          randrange(f32(index) * 2.0 + 1.0, -randomMag, randomMag)
        );
      }
    }
  `;
  const updateParticlesModule = device.createShaderModule({code: updateParticlesShader});

  const updateParticlesPipeline = device.createComputePipeline({
    compute: {
      module: updateParticlesModule,
      entryPoint: 'main',
    },
  });

  // a bind group for making the buffers available to the render pipeline
  // this is for things that are [[block]]s, not things that are attributes.
  const renderBindGroup = device.createBindGroup({
    layout: renderPipeline.getBindGroupLayout(0),
    entries: [
      {
        binding: 0,
        resource: {
          buffer: uniforms.dataBuffer,
          offset: 0,
          size: uniforms.totalSize,
        }
      },
    ]
  });
  const updateParticlesBindGroup = device.createBindGroup({
    layout: updateParticlesPipeline.getBindGroupLayout(0),
    entries: [
      {
        binding: 0,
        resource: {
          buffer: uniforms.dataBuffer,
          offset: 0,
          size: uniforms.totalSize,
        }
      },
      {
        binding: 1,
        resource: {
          buffer: particlesBuffer,
          offset: 0,
          size: initialParticleData.byteLength,
        }
      },
    ]
  });

  const frame = async () => {
    // a thing that encodes a list of commands to send to the GPU.
    // you can make multiple encoders to create several "command buffers", where everything in one command
    // buffer runs concurrently, but several command buffers submitted at once will run in sequence.
    const encoder = device.createCommandEncoder();
    await uniforms.setData({
      resolution: [width, height],
      mousePos: [mouseX, mouseY],
      mousePrevPos: [mousePx, mousePy],
      time: [(Date.now() - t0) / 1000],
      counter: [++counter],
      nParticles: [nParticles],
    });
    mousePx = mouseX;
    mousePy = mouseY;

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
    renderEncoder.setBindGroup(0, renderBindGroup);
    renderEncoder.setVertexBuffer(0, particlesBuffer);
    renderEncoder.draw(
      3, // vertex count
      nParticles, // instance count
      0, // first vertex
      0, // first instance
    ); // just like glDrawArrays!
    renderEncoder.endPass();

    const computeEncoder = encoder.beginComputePass();
    computeEncoder.setPipeline(updateParticlesPipeline);
    computeEncoder.setBindGroup(0, updateParticlesBindGroup);
    computeEncoder.dispatch(nParticles);
    computeEncoder.endPass();

    // send command buffers to the GPU!
    device.queue.submit([encoder.finish()]);
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
};

init();
