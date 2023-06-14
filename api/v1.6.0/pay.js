/*
 * @Author: luyu
 * @Date: 2022-05-29 16:37:57
 * @LastEditors: luyu
 * @FilePath: /steam-box-server/api/v1.6.0/pay.js
 * @Description: Do not edit
 */

let express = require('express');
const router = express.Router();
module.exports = router;

const mysql = require('../../plugins/mysql');
const rq = require('../../utils/request');
const alipay = require('../../plugins/alipay');
const wepay = require('../../plugins/wepay');

// 获取商品信息
router.post('/product_info', async (req, res) => {
    let mysql_obj = new mysql();
    let platform = req.body.platform;
    // 检查 platform
    ['ios', 'android'].includes(platform) || (() => {
        throw Error('参数异常')
    })();
    try {
        let box_db_con = await mysql_obj.connect('steam_box');
        // 获取平台下商品列表, 根据价格升序排列
        let [product_list] = await box_db_con.query('select * from product_info where platform = ? order by price asc', [platform]);
        res.json({
            success: true,
            result: product_list,
        });
    } catch (err) {
        res.json({
            success: false,
            msg: err.message
        });
    }
    if (mysql_obj) mysql_obj.end(); // 释放mysql连接，重要！！
})

// 新建订单号
router.post('/create_order', async (req, res) => {
    let mysql_obj = new mysql();
    let uid = req.user.uid;
    let pay_type = req.body.pay_type;
    let product_id = req.body.product_id;
    // 检查 pay_type
    ['ios', 'wepay', 'alipay'].includes(pay_type) || (() => {
        throw Error('参数异常')
    })();
    try {
        let box_db_con = await mysql_obj.connect('steam_box');
        // 根据当前时间生成唯一订单号
        let out_trade_no = new Date().getTime() + Math.random().toString().slice(2, 8);
        // 创建订单
        let order_data = {
            out_trade_no,
            uid,
            pay_type,
            remark: '订单已创建'
        }
        // 如果是微信或支付宝，则需要添加 product_id
        if (['wepay', 'alipay'].includes(pay_type)) {
            order_data.product_id = product_id;
        }
        await box_db_con.query('insert into pay_record set ?', order_data);

        res.json({
            success: true,
            result: out_trade_no,
        });
    } catch (err) {
        res.json({
            success: false,
            msg: err.message
        });
    }
    if (mysql_obj) mysql_obj.end(); // 释放mysql连接，重要！！
})

// iap 后端检查
router.post('/iap_check', async (req, res) => {
    let mysql_obj = new mysql();
    let uid = req.user.uid;
    let receipt_data = req.body.receipt_data;
    let order_id = req.body.order_id;
    (receipt_data && order_id) || (() => {
        throw Error('参数异常')
    })();
    let sandbox = req.body.sandbox;
    // 初始化检查完成标记
    let check_finish = false;
    try {
        let box_db_con = await mysql_obj.connect('steam_box');

        // 先查看是否有该用户的订单
        let order_data = await box_db_con.query('select * from pay_record where out_trade_no = ? and uid = ?', [order_id, uid]);
        if (order_data.length === 0) {
            check_finish = true;
            throw Error('订单不存在!');
        }

        // 向苹果服务器检查 receipt_data
        let options = {
            method: 'POST',
            url: sandbox ? 'https://sandbox.itunes.apple.com/verifyReceipt' : 'https://buy.itunes.apple.com/verifyReceipt',
            body: {
                'receipt-data': receipt_data
            }
        }
        let check_res = await rq(options, '^200$');

        // 检查结果, 如果 status 不为 0, 或者 in_app 数组为空, 则抛出异常
        if (check_res.status !== 0 || !check_res.receipt?.in_app?.length) {
            // 苹果校验不通过，存储到数据库
            let db_data = {
                success: 0,
                receipt_data,
                res: JSON.stringify(check_res),
                remark: '苹果校验不通过'
            }
            await box_db_con.query('update pay_record set ? where out_trade_no = ?', [db_data, order_id]);
            check_finish = true;
            throw Error(`支付失败 [0]`)
        }

        // 拿到最后一个 in_app 对象
        let in_app = check_res.receipt.in_app;
        let in_app_obj = in_app[in_app.length - 1];
        let product_id = in_app_obj.product_id;
        let transaction_id = in_app_obj.transaction_id;
        let purchase_date = new Date(parseInt(in_app_obj.purchase_date_ms));
        // 查询数据库是否已经存在交易
        const [transaction_rows] = await box_db_con.query('select * from pay_record where transaction_id = ?', [transaction_id]);
        // 如果不是本次订单，则记录为重复订单
        if (transaction_rows[0] && transaction_rows[0].out_trade_no !== order_id) {
            // 标记该交易已存在
            let db_data = {
                success: 0,
                product_id,
                receipt_data,
                res: JSON.stringify(check_res),
                remark: '重复交易'
            }
            await box_db_con.query('update pay_record set ? where out_trade_no = ?', [db_data, order_id]);
            check_finish = true;
            throw Error('支付失败 [1]');
        }

        // 查询商品信息
        const [product_rows] = await box_db_con.query('select * from product_info where product_id = ?', [product_id]);
        if (!product_rows.length) {
            // 标记商品不存在
            let db_data = {
                success: 0,
                product_id,
                purchase_date,
                transaction_id,
                receipt_data,
                res: JSON.stringify(check_res),
                remark: '商品不存在'
            }
            await box_db_con.query('update pay_record set ? where out_trade_no = ?', [db_data, order_id]);
            check_finish = true;
            throw Error('支付失败 [2]');
        }

        // 成功，将交易记录更新
        let db_data = {
            success: 1,
            pay_type: 'ios',
            product_id,
            purchase_date,
            transaction_id,
            receipt_data,
            res: JSON.stringify(check_res),
            remark: '交易成功'
        }
        await box_db_con.query('update pay_record set ? where out_trade_no = ?', [db_data, order_id]);

        // 给用户增加积分
        let product_info = product_rows[0];
        let base_points = product_info.base_points;
        let bonus_points = product_info.bonus_points;
        await box_db_con.query('update user_points set remain = remain + ? where uid = ?', [base_points + bonus_points, uid]);

        // 插入积分记录
        let points_record_data = {
            uid,
            record_type: 1,
            num: base_points + bonus_points,
            remark: `[IOS充值] 基础积分[${base_points}] + 奖励积分[${bonus_points}]`,
        }
        await box_db_con.query('insert into points_record set ?', points_record_data);

        res.json({
            check_finish: true,
            success: true,
            result: `支付成功!`,
        });
    } catch (err) {
        res.json({
            check_finish: check_finish,
            success: false,
            msg: err.message
        });
    }
    if (mysql_obj) mysql_obj.end(); // 释放mysql连接，重要！！
})

// 发起支付，微信或支付宝
router.post('/to_pay', async (req, res) => {
    let mysql_obj = new mysql();
    let uid = req.user.uid;
    let out_trade_no = req.body.out_trade_no || (() => {
        throw Error('缺少必填参数')
    })();
    // 支付方式 目前仅支持 alipay wepay
    let pay_type = req.body.pay_type;
    ['alipay', 'wepay'].includes(pay_type) || (() => {
        throw Error('支付方式错误')
    })();
    try {
        // 查询数据库，订单信息，属于该用户且 success 为 0
        let box_db_con = await mysql_obj.connect('steam_box');
        const [rows] = await box_db_con.query('select * from pay_record where out_trade_no = ? and uid = ? and success = 0 and pay_type = ?', [out_trade_no, uid, pay_type]);
        if (!rows.length) {
            throw Error('订单不存在');
        }
        let order_info = rows[0];
        let product_id = order_info.product_id;
        // 查询商品信息
        const [product_rows] = await box_db_con.query('select * from product_info where product_id = ?', [product_id]);
        if (!product_rows.length) {
            throw Error('您购买的商品不存在');
        }
        let product_info = product_rows[0];
        let price = product_info.price;
        let subject = `蒸汽工具箱-用户编号${uid}-${product_info.subject}`;
        // 生成支付链接
        let url = '';
        switch (pay_type) {
            case 'alipay':
                let alipay_obj = new alipay();
                url = await alipay_obj.wapPay(out_trade_no, price, subject);
                break;
            case 'wepay':
                let wepay_obj = new wepay();
                url = await wepay_obj.wapPay(out_trade_no, price, subject, req.ip);
                break;
            default:
                throw Error('支付方式错误');
        }
        if(!url) throw Error('支付链接生成失败');

        res.json({
            success: true,
            result: url,
        });
    } catch (err) {
        res.json({
            success: false,
            msg: err.message
        });
    }
    if (mysql_obj) mysql_obj.end(); // 释放mysql连接，重要！！
})