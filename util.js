const arrayTypeForElementType = (elementType) => {
  const arrayTypes = {
    'u8': Uint8Array,
    'u16': Uint16Array,
    'u32': Uint32Array,
    'i8': Int8Array,
    'i16': Int16Array,
    'i32': Int32Array,
    'f32': Float32Array,
    'f64': Float64Array,
  };
  if (!arrayTypes.hasOwnProperty(elementType)) {
    throw new Error(`Unsupported element type: ${elementType}`);
  }
  return arrayTypes[elementType];
};

const parseType = (type) => {
  const patterns = [
    [/^vec([2-4])<(\w+)>$/, (match) => {
      const ArrayType = arrayTypeForElementType(match[2]);
      return {
        type,
        length: Number.parseInt(match[1]),
        elementSize: ArrayType.BYTES_PER_ELEMENT,
        ArrayType,
      };
    }],
    [/^(\w+)$/, (match) => {
      const ArrayType = arrayTypeForElementType(match[1]);
      return {
        type,
        length: 1,
        elementSize: ArrayType.BYTES_PER_ELEMENT,
        ArrayType,
      }
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
  createUniforms(config) {
    // compute offsets for uniforms
    let totalOffset = 0;
    const uniforms = Object.fromEntries(Object.entries(config).map(([name, {type}]) => {
      const props = parseType(type);
      const size = props.elementSize * props.length;
      const offset = totalOffset;
      totalOffset += size;
      return [
        name,
        {
          ...props,
          offset,
        }
      ];
    }));

    const totalSize = totalOffset;
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
      const fields = Object.entries(uniforms).map(([name, {type}]) => {
        return `${name}: ${type};`;
      });
      return `
        [[block]] struct ${typeName} {
          ${fields.join('\n')}
        };
      `;
    };

    return {dataBuffer, totalSize, setData, structDefinition, uniforms};
  }
});
export default getUtils;
