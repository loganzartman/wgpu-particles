import getUtils from './util.js';
import dat from './dat.gui.module.js';

const setCursorVisible = (show) => {
  document.body.classList.remove(`cursor-${show ? 'hide' : 'show'}`);
  document.body.classList.add(`cursor-${show ? 'show' : 'hide'}`);
};

const init = async () => {
  if (!navigator.gpu) {
    alert('webgpu not supported');
    return;
  }

  const themes = {
    'additive': {
      bg: {r: 0.0, g: 0.0, b: 0.0, a: 1},
      blend: {
        color: {srcFactor: 'src-alpha', dstFactor: 'one', operation: 'add'},
        alpha: {srcFactor: 'one', dstFactor: 'one', operation: 'add'},
      },
    },
    'subtractive': {
      bg: {r: 1.0, g: 1.0, b: 1.0, a: 1},
      blend: {
        color: {srcFactor: 'src-alpha', dstFactor: 'one', operation: 'reverse-subtract'},
        alpha: {srcFactor: 'one', dstFactor: 'one', operation: 'add'},
      },
    },
    'alpha': {
      bg: {r: 0.0, g: 0.0, b: 0.0, a: 1},
      blend: {
        color: {srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add'},
        alpha: {srcFactor: 'one', dstFactor: 'one', operation: 'add'},
      },
    },
  };

  const params = {
    emitterRadius: 0.05,
    emitterCount: 2500.0,
    emitterSpeed: 0.5,
    emitterAccel: 0.2,
    emitterDamping: 0.2,
    randomVelocity: 0.1,
    randomAngle: 0.2,
    gravity: 0.0005,
    windStrength: 0.0005,
    dragCoeff: 0.01,
    theme: Object.keys(themes)[0],
    brightness: 0.5,
  };
  const gui = new dat.GUI({name: 'wgpu-particles'});
  const emitter = gui.addFolder('emitter');
  emitter.add(params, 'emitterRadius').min(0.001).max(0.5).step(0.001);
  emitter.add(params, 'emitterCount').step(1).min(1);
  emitter.add(params, 'emitterSpeed').step(0.01);
  emitter.add(params, 'emitterAccel').step(0.01).min(0).max(1);
  emitter.add(params, 'emitterDamping').step(0.01).min(0).max(1);
  emitter.add(params, 'randomVelocity').step(0.01).min(0).max(1);
  emitter.add(params, 'randomAngle').step(0.01).min(0).max(3.14);
  const physics = gui.addFolder('physics');
  physics.add(params, 'gravity').step(0.0001).min(0).max(0.01);
  physics.add(params, 'windStrength').step(0.0001).min(0).max(0.01);
  physics.add(params, 'dragCoeff').step(0.1).min(0).max(100);
  const visuals = gui.addFolder('visuals');
  const themeControl = visuals.add(params, 'theme').options(Object.keys(themes));
  visuals.add(params, 'brightness').min(0).max(1).step(0.01);

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
  let mouseDown = false;
  window.addEventListener('pointermove', (event) => {
    mouseX = event.clientX * window.devicePixelRatio;
    mouseY = event.clientY * window.devicePixelRatio;
  }, false);
  window.addEventListener('pointerdown', (event) => {
    if (event.target === canvas) {
      mouseDown = true;
      setCursorVisible(false);
    }
  });
  window.addEventListener('pointerup', (event) => {
    mouseDown = false;
    setCursorVisible(true);
  });

  let emitterX = window.innerWidth * window.devicePixelRatio / 2;
  let emitterY = window.innerWidth * window.devicePixelRatio / 2;
  let emitterVx = 0;
  let emitterVy = 0;
  let emitterPx = emitterX;
  let emitterPy = emitterY;

  const uniforms = utils.createUniforms(
    {
      resolution: {type: 'vec2<f32>'},
      emitterPos: {type: 'vec2<f32>'},
      emitterPrevPos: {type: 'vec2<f32>'},
      time: {type: 'f32'},
      counter: {type: 'f32'},
      nParticles: {type: 'f32'},
      gravity: {type: 'f32'},
      windStrength: {type: 'f32'},
      dragCoeff: {type: 'f32'},
      emitterRadius: {type: 'f32'},
      emitterCount: {type: 'f32'},
      emitterSpeed: {type: 'f32'},
      brightness: {type: 'f32'},
      randomVelocity: {type: 'f32'},
      randomAngle: {type: 'f32'},
    }, 
  );

  const uniformsChunk = /* wgsl */`
    ${uniforms.structDefinition('Uniforms')}
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

    // adapted from nimitz from inigo quilez
    // https://www.shadertoy.com/view/Xt3cDn
    fn hashInt(x: vec2<i32>) -> u32 {
      var p = vec2<u32>(x); // reinterpret cast
      p = vec2<u32>(1103515245u) * ((p >> vec2<u32>(1u)) ^ (p.yx));
      let h32 = 1103515245u * ((p.x) ^ (p.y >> 3u));
      return h32 ^ (h32 >> 16u);
    }

    fn hash2(x: vec2<i32>) -> f32 {
      let n = hashInt(x);
      return f32(n) * (1.0 / f32(0xffffffffu));
    }

    // adapted from inigo quilez
    // https://www.shadertoy.com/view/XlXcW4
    let kHash = 1103515245u;  // GLIB C
    fn hash3(input: vec3<i32>) -> vec3<f32> {
      var x = vec3<u32>(input); // reinterpret cast
      x = ((x >> vec3<u32>(8u)) ^ x.yzx) * kHash;
      x = ((x >> vec3<u32>(8u)) ^ x.yzx) * kHash;
      x = ((x >> vec3<u32>(8u)) ^ x.yzx) * kHash;
      return vec3<f32>(x) * (1.0 / f32(0xffffffffu));
    }

    // adapted from ken perlin
    fn quintic(x: f32) -> f32 {
      return x * x * x * (x * (x * 6.0 - 15.0) + 10.0);
    }

    // 3D gradient noise adapted from inigo quilez
    // https://www.shadertoy.com/view/XdXGW8
    fn noise(p: vec3<f32>) -> f32 {
      let i = vec3<i32>(floor(p));
      let f = fract(p);
      let u = vec3<f32>(quintic(f.x), quintic(f.y), quintic(f.z));

      return mix(mix(mix(dot(hash3(i + vec3<i32>(0, 0, 0)), f - vec3<f32>(0.0, 0.0, 0.0)), 
                         dot(hash3(i + vec3<i32>(1, 0, 0)), f - vec3<f32>(1.0, 0.0, 0.0)), u.x),
                     mix(dot(hash3(i + vec3<i32>(0, 1, 0)), f - vec3<f32>(0.0, 1.0, 0.0)), 
                         dot(hash3(i + vec3<i32>(1, 1, 0)), f - vec3<f32>(1.0, 1.0, 0.0)), u.x), u.y),
                 mix(mix(dot(hash3(i + vec3<i32>(0, 0, 1)), f - vec3<f32>(0.0, 0.0, 1.0)), 
                         dot(hash3(i + vec3<i32>(1, 0, 1)), f - vec3<f32>(1.0, 0.0, 1.0)), u.x),
                     mix(dot(hash3(i + vec3<i32>(0, 1, 1)), f - vec3<f32>(0.0, 1.0, 1.0)), 
                         dot(hash3(i + vec3<i32>(1, 1, 1)), f - vec3<f32>(1.0, 1.0, 1.0)), u.x), u.y), u.z);
    }

    fn windForce(pos: vec2<f32>) -> vec2<f32> {
      let windX = noise(vec3<f32>(pos * 2.19012, uniforms.time * 0.2)) 
                + noise(vec3<f32>(pos * 4.3589, uniforms.time * 0.5)) * 0.5;
      let windY = noise(vec3<f32>(pos * 2.19012, uniforms.time * 0.2 + 221.298)) 
                + noise(vec3<f32>(pos * 4.3589, uniforms.time * 0.5 + 121.99)) * 0.5;
      return vec2<f32>(windX, windY);
    }

    fn wrappedDiff(a: f32, b: f32, modulo: f32) -> f32 {
      let am = a % modulo;
      let bm = b % modulo;
      var result = am - bm;
      if (am < bm) {
        result = (modulo - bm) + am;
      }
      return result;
    }
  `;

  // create initial data for particles
  const nParticles = 1000000;
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
      let scale = vec2<f32>(0.005, length(particleVel));
      // not sure why this has to be a variable
      var vertexCoords = array<vec2<f32>, 3>(
        vec2<f32>(0.0, -0.5),
        vec2<f32>(0.5, 0.5),
        vec2<f32>(-0.5, 0.5)
      );
      let vertex = vertexCoords[vertexIndex];
      let center = particlePos * vec2<f32>(2.0, -2.0);
      let angle = atan2(particleVel.x, particleVel.y);
      let pos = vec2<f32>(
        (vertex.x * scale.x * cos(angle)) - (vertex.y * scale.y * sin(angle)),
        (vertex.x * scale.x * sin(angle)) + (vertex.y * scale.y * cos(angle))
      );
      var output : VertexOutput;
      output.position = vec4<f32>(vec2<f32>(-1.0, 1.0) + center + pos, 0.0, 1.0);
      output.color = vec4<f32>(
        hsv2rgb(vec3<f32>(
          f32(instanceIndex) / uniforms.nParticles, 
          randrange(f32(instanceIndex), 0.3, 0.7), 
          1.0
        )), 
        uniforms.brightness * (wrappedDiff(f32(instanceIndex), uniforms.counter * uniforms.emitterCount, uniforms.nParticles) / uniforms.nParticles),
      );
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
  let renderPipeline;
  const createRenderPipeline = () => {
    renderPipeline = device.createRenderPipeline({
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
        targets: [
          {
            format: textureFormat,
            blend: themes[params.theme].blend,
          }
        ],
      },
      primitive: {
        // what geometric primitive(s) the vertices represent; same as GL
        topology: 'triangle-list',
      }
    });
  };
  createRenderPipeline();
  themeControl.onChange(() => createRenderPipeline());

  const bgShader = /* wgsl */`
    ${uniformsChunk}
    ${utilChunk}

    [[stage(vertex)]]
    fn vert_main(
      [[builtin(vertex_index)]] vertexIndex : u32,
    ) -> [[builtin(position)]] vec4<f32> {
      var pos = array<vec4<f32>, 6>(
        vec4<f32>(-1.0, -1.0, 0.0, 1.0),
        vec4<f32>(1.0, -1.0, 0.0, 1.0),
        vec4<f32>(1.0, 1.0, 0.0, 1.0),
        vec4<f32>(-1.0, -1.0, 0.0, 1.0),
        vec4<f32>(1.0, 1.0, 0.0, 1.0),
        vec4<f32>(-1.0, 1.0, 0.0, 1.0),
      );
      return pos[vertexIndex];
    }

    [[stage(fragment)]]
    fn frag_main(
      [[builtin(position)]] position: vec4<f32>,
    ) -> [[location(0)]] vec4<f32> {
      return vec4<f32>(0.0, 0.0, 0.0, 0.0);
      // return vec4<f32>(windForce(position.xy / uniforms.resolution), 0.0, 1.0);
    }
  `;
  const bgModule = device.createShaderModule({code: bgShader});

  const renderBgPipeline = device.createRenderPipeline({
    vertex: {
      module: bgModule,
      entryPoint: 'vert_main',
    },
    fragment: {
      module: bgModule,
      entryPoint: 'frag_main',
      targets: [{format: textureFormat}],
    },
    primitive: {
      topology: 'triangle-list',
    },
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
      let index = globalInvocationId.x;
      // physics integration
      var pos = particles.particles[index].pos;
      var vel = particles.particles[index].vel;
      pos = pos + vel;
      vel.y = vel.y + uniforms.gravity;

      // wind
      vel = vel + windForce(pos) * uniforms.windStrength;

      // mouse interaction
      let counterDiff = wrappedDiff(f32(index), uniforms.counter * uniforms.emitterCount, uniforms.nParticles);
      if (counterDiff < uniforms.emitterCount) {
        let posA = uniforms.emitterPrevPos / uniforms.resolution;
        let posB = uniforms.emitterPos / uniforms.resolution;
        let dx = posB - posA;
        var angle = atan2(dx.y, dx.x);
        var len = length(dx);
        angle = angle + randrange(f32(index) * 91.24111, -uniforms.randomAngle, uniforms.randomAngle);
        len = len * randrange(f32(index) * 15.15981, 0.2, 1.0);
        let f = counterDiff / uniforms.emitterCount;
        let discAngle = randrange(f32(index) * 0.71873, 0.0, 6.28);
        let discLen = randrange(f32(index) * 3.19888, 0.0, uniforms.emitterRadius);
        let disc = vec2<f32>(cos(discAngle) * discLen, sin(discAngle) * discLen);
        let newDx = vec2<f32>(cos(angle) * len, sin(angle) * len);
        pos = disc + posA * (1.0 - f) + posB * f;
        let randomMag = 1.0;
        vel = newDx * uniforms.emitterSpeed * vec2<f32>(
          randrange(f32(index) * 2.135708, 1.0 - uniforms.randomVelocity, 1.0),
          randrange(f32(index) * 1.198923, 1.0 - uniforms.randomVelocity, 1.0)
        );
      }

      // drag
      vel = vel - vel * uniforms.dragCoeff * pow(length(vel), 2.0);

      // write back
      particles.particles[index].pos = pos;
      particles.particles[index].vel = vel;
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
  const renderBgBindGroup = device.createBindGroup({
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

  // do the host-side physics for the emitter 
  const physicsStep = () => {
    let targetX = Math.cos(Date.now() / 100.0) * width * 0.2 + width * 0.5;
    let targetY = Math.sin(Date.now() / 100.0) * height * 0.2 + height * 0.5;
    if (mouseDown) {
      targetX = mouseX;
      targetY = mouseY;
    }
    const dx = targetX - emitterX;
    const dy = targetY - emitterY;
    emitterVx += dx * params.emitterAccel;
    emitterVy += dy * params.emitterAccel;
    emitterX += emitterVx;
    emitterY += emitterVy;
    emitterVx *= 1 - params.emitterDamping;
    emitterVy *= 1 - params.emitterDamping;
  }

  const frame = async () => {
    // a thing that encodes a list of commands to send to the GPU.
    // you can make multiple encoders to create several "command buffers", where everything in one command
    // buffer runs concurrently, but several command buffers submitted at once will run in sequence.
    const encoder = device.createCommandEncoder();

    physicsStep();

    await uniforms.setData({
      resolution: [width, height],
      emitterPos: [emitterX, emitterY],
      emitterPrevPos: [emitterPx, emitterPy],
      time: (Date.now() - t0) / 1000,
      counter: ++counter,
      nParticles: nParticles,
      gravity: params.gravity,
      windStrength: params.windStrength,
      dragCoeff: params.dragCoeff,
      emitterRadius: params.emitterRadius,
      emitterCount: params.emitterCount,
      emitterSpeed: params.emitterSpeed,
      brightness: params.brightness,
      randomVelocity: params.randomVelocity,
      randomAngle: params.randomAngle,
    });
    emitterPx = emitterX;
    emitterPy = emitterY;

    const computeEncoder = encoder.beginComputePass();
    computeEncoder.setPipeline(updateParticlesPipeline);
    computeEncoder.setBindGroup(0, updateParticlesBindGroup);
    computeEncoder.dispatch(nParticles);
    computeEncoder.endPass();

    // the texture we should render to for this frame (i.e. not the one currently being displayed)
    const textureView = ctx.getCurrentTexture().createView();

    {
      const renderEncoder = encoder.beginRenderPass({
        colorAttachments: [
          {
            view: textureView,
            loadValue: {r: 0, g: 0, b: 0, a: 1.0},
            storeOp: 'store',
          }
        ]
      })
      renderEncoder.setPipeline(renderBgPipeline);
      renderEncoder.setBindGroup(0, renderBgBindGroup);
      renderEncoder.draw(6, 1, 0, 0);
      renderEncoder.endPass();
    }
    {
      // encode a render pass (as opposed to a compute pass)
      const renderEncoder = encoder.beginRenderPass({
        // you get a color attachment by default in GL (e.g. where gl_FragColor or location 0 goes), but they're also configurable in GL.
        colorAttachments: [
          {
            view: textureView, // the output texture for this color attachment
            // this is either 'load' or a color. If 'load', load the existing texture data into the render pass.
            // If a color, clear the texture to this color instead. This is preferred, because 'load' is expensive on some hardware.
            // This is like glClearColor.
            // loadValue: 'load',
            loadValue: themes[params.theme].bg,
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
    }

    // send command buffers to the GPU!
    device.queue.submit([encoder.finish()]);
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
};

init();
