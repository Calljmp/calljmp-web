const { withNx } = require('@nx/rollup/with-nx');

module.exports = withNx(
  {
    main: './src/react/index.tsx',
    outputPath: './dist/react',
    tsConfig: './tsconfig.lib.json',
    compiler: 'babel',
    format: ['cjs', 'esm'],
    external: ['react', 'react/jsx-runtime'],
  },
  {
    output: { sourcemap: false },
  }
);
