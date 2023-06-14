/*
 * @Author: luyu
 * @Date: 2021-06-09 01:28:46
 * @LastEditors: luyu
 * @LastEditTime: 2022-06-19 15:33:03
 */
const path = require('path');
const express = require('express');

// 全局 promise 错误捕获
require('express-async-errors');
const cookieParser = require('cookie-parser');
const morgan = require('morgan');
const app = express();

app.use(morgan('dev'));
app.use(cookieParser());
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(express.static(path.join(__dirname, '.', 'dist')));

// 自定义跨域中间件
const allowCors = function (req, res, next) {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET,PUT,POST,DELETE,OPTIONS');
    res.header('Access-Control-Allow-Credentials', 'true');
    res.header('Access-Control-Max-Age', 3600);
    res.header('Access-Control-Allow-Headers', 'content-type,authorization');
    next();
};
app.use(allowCors);//使用跨域中间件

// 使用代理获取用户ip
app.set('trust proxy', true);

// express版本路由
const expressJwt = require('express-jwt');
app.use('/', expressJwt({
    secret: 'xxx',
    algorithms: ['HS256'],
    getToken: function getAccessToken(req) {
        if (req.headers.authorization) {
            return req.headers.authorization;
        }
        return null;
    }
}).unless({
    path: [/\/2fa\/.{1,10}$/, /\/pre\/.{1,10}$/, /\/test\/.{1,10}$/]  // 指定路径不经过 Token 解析
}))

// express路由，app.use(router)
app.use('/pre', require('./pre'));
app.use('/user', require('./user'));
app.use('/2fa', require('./2fa'));
app.use('/steam_account', require('./steam_account'));
app.use('/steam_bot', require('./steam_bot'));
app.use('/steam_bot_tools', require('./steam_bot_tools'));
app.use('/steam_api', require('./steam_api'));
app.use('/pay', require('./pay'));
app.use('/activity', require('./activity'));
app.use('/test', require('./test'));

// 全局异常处理
app.use((err, req, res, next) => {
    if (err.name === 'UnauthorizedError') {
        res.status(401).json({ code: '401', msg: 'Invalid token' });
    } else {
        // console.error(err);
        res.status(500).json({ code: '500', msg: err.message });
    }
});

module.exports = app;
