const getUtils = ({device}) => ({
  createUniforms(config, {ArrayType=Float32Array}={}) {
    const elementSize = ArrayType.BYTES_PER_ELEMENT;

    // compute offsets for uniforms
    let totalOffset = 0;
    const uniforms = Object.fromEntries(Object.entries(config).map(([name, {length}]) => {
      const size = length * elementSize;
      const offset = totalOffset;
      totalOffset += size;
      return [
        name,
        {
          size,
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
        const {offset, size} = uniform;
        if (data.length > size) {
          throw new Error('Uniform data size mismatch');
        }
        device.queue.writeBuffer(
          dataBuffer,
          offset, // offset in bytes
          new ArrayType(data),
          0,
          size / elementSize, // size in elements
        );
      });
    };

    return {dataBuffer, totalSize, setData, uniforms};
  }
});
export default getUtils;
