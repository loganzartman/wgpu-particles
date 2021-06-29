const arrayTypeForScalarType = (scalarType) => {
  const arrayTypes = {
    'u32': Uint32Array,
    'i32': Int32Array,
    'f32': Float32Array,
    /* 
    // "reserved for future expansion"
    'bool': Uint8Array,
    'u8': Uint8Array,
    'i8': Int8Array,
    'u16': Uint16Array,
    'i16': Int16Array,
    'f64': Float64Array,
    */
  };
  if (!arrayTypes.hasOwnProperty(scalarType)) {
    throw new Error(`Unsupported scalar type: ${scalarType}`);
  }
  return arrayTypes[scalarType];
};

const greaterPowerOf2 = (x) => 2 ** Math.ceil(Math.log2(x));
const roundUp = (base, value) => base * Math.ceil(value / base);

const REX_MATRIX = /^mat([2-4])x([2-4])<(\w+)>$/;
const REX_VECTOR = /^vec([2-4])<(\w+)>$/;
const REX_SCALAR = /^(\w+)$/;

const parseType = (type) => {
  const patterns = [
    [REX_MATRIX, (match) => {
      const ArrayType = arrayTypeForScalarType(match[3]);
      const n = Number.parseInt(match[1]);
      const m = Number.parseInt(match[2]);
      const length = n * m;
      const elementSize = ArrayType.BYTES_PER_ELEMENT;
      const vecM = parseType(`vec${m}<${match[3]}>`);
      const alignOf = vecM.alignOf * n;
      const sizeOf = n * roundUp(vecM.alignOf, vecM.sizeOf);
      return {
        category: 'matrix',
        type,
        length,
        elementSize,
        sizeOf,
        alignOf,
        ArrayType,
      };
    }],
    [REX_VECTOR, (match) => {
      const ArrayType = arrayTypeForScalarType(match[2]);
      const length = Number.parseInt(match[1]);
      const elementSize = ArrayType.BYTES_PER_ELEMENT;
      const sizeOf = length * elementSize;
      const alignOf = greaterPowerOf2(sizeOf);
      return {
        category: 'vector',
        type,
        length,
        elementSize,
        sizeOf,
        alignOf,
        ArrayType,
      };
    }],
    [REX_SCALAR, (match) => {
      const ArrayType = arrayTypeForScalarType(match[1]);
      const elementSize = ArrayType.BYTES_PER_ELEMENT;
      return {
        category: 'scalar',
        type,
        length: 1,
        elementSize,
        sizeOf: elementSize,
        alignOf: elementSize,
        ArrayType,
      };
    }],
  ];

  for (const [pattern, fn] of patterns) {
    const match = pattern.exec(type);
    if (match) {
      return fn(match);
    }
  }
  throw new Error(`Unsupported uniform type: ${type}`);
};

const getUtils = ({device}) => ({
  structLayout(config) {
    let totalOffset = 0;

    const layout = Object.fromEntries(Object.entries(config).map(([name, {type}]) => {
      const props = parseType(type);
      const offset = roundUp(props.alignOf, totalOffset);
      totalOffset = offset + props.sizeOf;
      return [
        name,
        {
          ...props,
          offset,
        }
      ];
    }));

    const maxAlign = Object.values(layout).reduce(
      (max, {alignOf}) => Math.max(max, alignOf),
      0,
    );

    const totalSize = roundUp(maxAlign, totalOffset);

    return {layout, maxAlign, totalSize};
  },

  createUniforms(config) {
    // compute offsets for uniforms
    const {layout: uniforms, totalSize} = this.structLayout(config);

    const dataBuffer = device.createBuffer({
      // COPY_DST mode means this buffer will be the target of buffer copy operations
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      size: totalSize, // in bytes
    });

    const setData = async (uniformsData) => {
      Object.entries(uniformsData).forEach(([name, data]) => {
        const uniform = uniforms[name];
        const {offset, length, ArrayType} = uniform;
        if (!Array.isArray(data)) {
          if (length > 1) {
            throw new Error(`Trying to set non-array value for length ${length} uniform.`);
          }
          data = [data];
        }
        if (data.length > length) {
          throw new Error('Uniform data size mismatch');
        }
        device.queue.writeBuffer(
          dataBuffer,
          offset, // offset in bytes
          new ArrayType(data),
          0,
          length, // size in elements
        );
      });
    };

    const structDefinition = (typeName) => {
      const fields = Object.entries(uniforms).map(([name, {type, alignOf, sizeOf, offset}]) => {
        return ` [[align(${alignOf})]] [[size(${sizeOf})]] ${name}: ${type};`;
      });
      return [
        `[[block]] struct ${typeName} {`,
        fields.join('\n'),
        `};`
      ].join('\n');
    };

    return {dataBuffer, totalSize, setData, structDefinition, uniforms};
  }
});
export default getUtils;
