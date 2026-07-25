const path = require('path');
const webpack = require('webpack');



const CopyWebpackPlugin = require('copy-webpack-plugin');
const { CleanWebpackPlugin } = require('clean-webpack-plugin');
const HtmlWebpackPlugin = require('html-webpack-plugin');


module.exports = {
    entry: [ "./src/index.ts", './src/worker.ts'],
    output: {
        libraryExport: "default",
        path: path.resolve(__dirname, './dist'),
        filename: "main.js"
    },
    module: {

        rules: [
            {
                test: /\.(ts|js)$/,
                exclude: /node_modules/,
                use: [
                    {
                        loader: "babel-loader"
                    },
                    {
                        loader: "ts-loader",
                        options: {
                            allowTsInNodeModules: false
                        }
                    }
                ],
            },

            {
                test: /\.css$/i,
                use: ["style-loader", "css-loader", "postcss-loader"],
            }

        ],

    },

    plugins: [

        new HtmlWebpackPlugin({
            template: 'src/index.html'
        }),

        new CleanWebpackPlugin({
            cleanStaleWebpackAssets: false
        }),
        new CopyWebpackPlugin( {
            patterns: [
                { from: "src/*.js", to: path.basename('[name].js') },
                { from: "src/img/*.svg", to: path.basename('[name].svg') },
                { from: "src/img/*.png", to: path.basename('[name].png') },
                { from: "node_modules/web-demuxer/dist/wasm-files/web-demuxer.wasm", to: "web-demuxer.wasm" },
                { from: "node_modules/@fontsource-variable/manrope/files/manrope-latin-wght-normal.woff2", to: "fonts/manrope-latin-wght-normal.woff2" }
            ]
        })

    ],
    resolve: {
        extensions: [".ts", ".tsx", ".js",  ".css"]
    },

    devServer: {
        static: {
            directory: path.join(__dirname, 'dist'),
        },
        headers: {
            "Access-Control-Allow-Origin": "*",
            "Cross-Origin-Opener-Policy": "same-origin",
            "Cross-Origin-Embedder-Policy": "require-corp"
        },
        compress: true,
        port: 8080,
        allowedHosts: "all",
    },

    mode: 'development'

};
