/*
 * @Author: luyu
 * @Date: 2022-02-23 20:04:18
 * @LastEditors: luyu
 * @LastEditTime: 2022-06-21 13:25:16
 * @FilePath: /steam-box-server/api/v1.6.0/steam_account.js
 * @Description: steam 账号配额管理与其他 steam 接口调用
 */
let express = require('express');
const mysql = require('../../plugins/mysql');
let router = express.Router();
const aes = require('../../utils/aes');
const asf = require('../../plugins/asf');

// 获取账号所有配额信息
router.get('/info', async (req, res) => {
    let mysql_obj = new mysql();
    let uid = req.user.uid;
    try {
        // 后台系统维护中
        let box_db_con = await mysql_obj.connect('steam_box');
        // 处理steam账号相关信息
        let [steam_rows] = await box_db_con.query('select sid,steam_uname,steam_id,duedate,host,steam_config from steam_account where uid = ?', uid);
        let steam_account = {};
        let steam_account_res = {};
        if (steam_rows.length !== 0) {
            // 先根据服务器host，对账号进行分组
            for (let i = 0, len = steam_rows.length; i < len; i++) {
                let host = steam_rows[i].host;

                if (!steam_account[host]) {
                    steam_account[host] = {}
                    steam_account[host].bots = []
                    steam_account[host].botsSid = []
                    steam_account[host].account = []
                }

                if (steam_rows[i].steam_uname) {
                    steam_account[host].bots.push(steam_rows[i].steam_uname)
                    steam_account[host].botsSid.push(steam_rows[i].sid);
                }

                // 获取已配置刷时长游戏列表
                if (steam_rows[i].steam_id) {
                    let games_db_con = await mysql_obj.connect('user_games');
                    let steam_id = steam_rows[i].steam_id;
                    // 生成游戏表名称
                    let table_id = steam_id.slice(-2);
                    let table_name = `user_games_info_${table_id}`;
                    let [games_rows] = await games_db_con.query('select game_id,game_name,played_time,selected from ?? where steam_id = ? and selected = 1', [table_name, steam_id]);
                    steam_rows[i].idle_games = games_rows;
                } else {
                    steam_rows[i].idle_games = [];
                }

                // 去除敏感信息
                delete steam_rows[i].host;
                if (steam_rows[i].steam_config) {
                    steam_rows[i].temp_uname = steam_rows[i].steam_config.SteamLogin;
                }
                delete steam_rows[i].steam_config;
                steam_account[host].account.push(steam_rows[i])
            }

            // 再对每个host进行加密处理生成target
            for (let host in steam_account) {
                let key = aes.encrypt(host).slice(-10);
                steam_account_res[key] = {
                    target: null,
                    botsSid: steam_account[host].botsSid,
                    account: steam_account[host].account
                }

                if (steam_account[host].bots.length !== 0) {
                    let target_obj = {
                        botHost: host,
                        botLog: steam_account[host].bots.join('|')
                    }
                    steam_account_res[key].target = aes.encrypt(JSON.stringify(target_obj))
                }
            }
        }

        res.json({
            success: true,
            result: steam_account_res
        });
    } catch (err) {
        res.json({
            success: false,
            msg: err.message
        });
    }
    if (mysql_obj) mysql_obj.end(); // 释放mysql连接，重要！！
})

// 获取steam账号日志信息
router.get('/record', async (req, res) => {
    let mysql_obj = new mysql();
    let uid = req.user.uid;
    try {
        let box_db_con = await mysql_obj.connect('steam_box');
        // 读取steam_record表，最新的3条记录
        let [record_rows] = await box_db_con.query('select content,record_date from steam_record where uid = ? order by rid desc limit 2', uid);
        res.json({
            success: true,
            result: record_rows || []
        });
    } catch (err) {
        res.json({
            success: false,
            msg: err.message
        });
    }
    if (mysql_obj) mysql_obj.end(); // 释放mysql连接，重要！！
})


// 导入备用令牌
router.post('/upload_token', async (req, res) => {
    let mysql_obj = new mysql();
    let uid = req.user.uid;
    let sid = req.body.sid || (() => {
        throw Error('缺少必填参数')
    })();
    let steam_token = req.body.steam_token || (() => {
        throw Error('缺少必填参数')
    })();
    try {
        // 检查 steam_token 是否合法，要求数组长度不能超过30
        if (!Array.isArray(steam_token) || steam_token.length > 30) {
            throw Error('备用令牌格式错误[1]')
        }
        // 要求每一个都是7位字母数字组合
        steam_token.forEach((item) => {
            /^[a-zA-Z0-9]{7}$/.test(item) || (() => {
                throw Error('备用令牌格式错误[2]')
            })();
        })

        let box_db_con = await mysql_obj.connect('steam_box');
        const [steam_rows] = await box_db_con.query('select steam_uname,steam_id from steam_account where uid = ? and sid = ?', [uid, sid]);
        if (steam_rows.length === 0) {
            throw Error(`当前配额不存在,请刷新后重试!`)
        }

        // 导入备用令牌，更新数据库
        await box_db_con.query('update steam_account set steam_token = ? where uid = ? and sid = ?', [JSON.stringify(steam_token), uid, sid]);
        res.json({
            success: true,
            result: `成功导入备用令牌:${steam_token.length}个`
        });
    } catch (err) {
        res.json({
            success: false,
            msg: err.message
        });
    }
    if (mysql_obj) mysql_obj.end(); // 释放mysql连接，重要！！
})

// 获取备用令牌
router.post('/get_token', async (req, res) => {
    let mysql_obj = new mysql();
    let uid = req.user.uid;
    let sid = req.body.sid || (() => {
        throw Error('缺少必填参数')
    })();
    try {
        let box_db_con = await mysql_obj.connect('steam_box');
        const [steam_rows] = await box_db_con.query('select steam_uname,steam_id from steam_account where uid = ? and sid = ?', [uid, sid]);
        if (steam_rows.length === 0) {
            throw Error(`当前配额不存在,请刷新后重试!`)
        }

        // 获取备用令牌
        const [token_rows] = await box_db_con.query('select steam_token from steam_account where uid = ? and sid = ?', [uid, sid]);
        res.json({
            success: true,
            result: token_rows[0].steam_token || []
        });
    } catch (err) {
        res.json({
            success: false,
            msg: err.message
        });
    }
    if (mysql_obj) mysql_obj.end(); // 释放mysql连接，重要！！
})

// 删除备用令牌
router.post('/del_token', async (req, res) => {
    let mysql_obj = new mysql();
    let uid = req.user.uid;
    let sid = req.body.sid || (() => {
        throw Error('缺少必填参数')
    })();
    let token = req.body.token || (() => {
        throw Error('缺少必填参数')
    })();
    // 检查 token 是否合法，要求7位字母数字组合
    if (token !== 'all') {
        /^[a-zA-Z0-9]{7}$/.test(token) || (() => {
            throw Error('删除备用令牌格式错误')
        })();
    }
    try {
        let box_db_con = await mysql_obj.connect('steam_box');
        const [steam_rows] = await box_db_con.query('select steam_uname,steam_id from steam_account where uid = ? and sid = ?', [uid, sid]);
        if (steam_rows.length === 0) {
            throw Error(`当前配额不存在,请刷新后重试!`)
        }

        // 获取备用令牌
        const [token_rows] = await box_db_con.query('select steam_token from steam_account where uid = ? and sid = ?', [uid, sid]);
        let steam_token = token_rows[0].steam_token || [];
        if (token === 'all') {
            steam_token = [];
        }else {
            steam_token = steam_token.filter(item => item !== token);
        }

        // 删除备用令牌，更新数据库
        await box_db_con.query('update steam_account set steam_token = ? where uid = ? and sid = ?', [JSON.stringify(steam_token), uid, sid]);
        res.json({
            success: true,
            result: `成功删除备用令牌:${token === 'all' ? '全部' : token}`
        });
    } catch (err) {
        res.json({
            success: false,
            msg: err.message
        });
    }
    if (mysql_obj) mysql_obj.end(); // 释放mysql连接，重要！！
})

// 兑换使用时间
router.post('/add_time', async (req, res) => {
    let mysql_obj = new mysql();
    let uid = req.user.uid;
    let sid = req.body.sid;
    let usePoints = req.body.usePoints || (() => {
        throw Error('缺少必填参数')
    })();
    try {
        // 正整数
        if (!/^[1-9]\d*$/.test(usePoints)) {
            throw Error('使用积分异常')
        }

        // 判断是否有足够积分
        let box_db_con = await mysql_obj.connect('steam_box');
        let [points_rows] = await box_db_con.query('select remain from user_points where uid = ?', uid);
        if (!points_rows[0] || points_rows[0].remain < usePoints) {
            throw Error('当前账号无足够积分！')
        }

        // 扣除积分
        let [update_rows] = await box_db_con.query('update user_points set remain = ? where uid = ?', [points_rows[0].remain - usePoints, uid]);

        // 再增加使用时间
        let [sid_rows] = await box_db_con.query('select duedate from steam_account where uid = ? and sid = ?', [uid, sid]);
        let today = new Date();
        let new_date;
        if (sid_rows.length === 0) {
            // 无指定 sid，则插入新 steam 配额
            // 判断是否达到最大配额，查询steam_account数量
            let [account_rows] = await box_db_con.query('select count(sid) as count from steam_account where uid = ?', uid);
            // 查询账号的最大配额限制
            let [max_rows] = await box_db_con.query('select max_account_num from user_info where uid = ?', uid);
            if (account_rows[0].count >= max_rows[0].max_account_num) {
                throw Error('账号已达到最大配额!')
            }
            // 插入新 steam 配额
            new_date = new Date(today.getTime() + 1000 * 60 * 60 * usePoints);
            let val = {
                "uid": uid,
                "duedate": new_date
            }
            let [insert_rows] = await box_db_con.query('insert into steam_account set ?', val);
            sid = insert_rows.insertId;
        } else {
            // 指定 sid，更新到期时间
            let duedate = new Date(sid_rows[0].duedate);
            // 如果已经过期，从今天开始续费
            if (duedate < today) {
                duedate = today;
            }
            new_date = new Date(duedate.getTime() + 1000 * 60 * 60 * usePoints);
            let [update_rows] = await box_db_con.query('update steam_account set duedate = ? where sid = ?', [new_date, sid]);
        }

        // 再添加积分使用记录
        let val = {
            uid: uid,
            record_type: 0,
            num: usePoints,
            remark: `[增加时长] 给[sid:${sid}]增加[${usePoints}时]`
        }
        let [insert_rows] = await box_db_con.query('insert into points_record set ?', val);

        res.json({
            success: true,
            result: `[增加时长] 给[sid:${sid}]增加[${usePoints}时]`,
            new_date
        });
    } catch (err) {
        res.json({
            success: false,
            msg: err.message
        });
    }
    if (mysql_obj) mysql_obj.end(); // 释放mysql连接，重要！！
})

// 初始化账号游戏库
router.post('/config_game_init', async (req, res) => {
    let mysql_obj = new mysql();
    let uid = req.user.uid;
    let sid = req.body.sid || (() => {
        throw Error('缺少必填参数')
    })();
    // steam_id 正则表达式验证 17 位数字
    let steam_id = req.body.steam_id || (() => {
        throw Error('缺少必填参数')
    })();
    /^\d{17}$/.test(steam_id) || (() => {
        throw Error('[格式错误]steam_id')
    })();
    try {
        let box_db_con = await mysql_obj.connect('steam_box');
        const [steam_rows] = await box_db_con.query('select steam_uname,steam_id from steam_account where uid = ? and sid = ?', [uid, sid]);
        if (steam_rows.length === 0) {
            throw Error(`当前配额不存在,请刷新后重试!`)
        }

        let steam_account = steam_rows[0];
        if (!steam_account.steam_uname) {
            throw Error(`不存在可配置的Steam账号`)
        }

        if (steam_account.steam_id) {
            throw Error(`当前账号已经初始化过了`)
        }

        // 生成游戏表名称
        let table_id = steam_id.slice(-2);
        let table_name = `user_games_info_${table_id}`;

        // 判断表是否存在，使用过count(*)来判断
        let games_db_con = await mysql_obj.connect('user_games');
        let [count_rows] = await games_db_con.query('select count(*) as count from information_schema.tables where table_schema = ? and table_name = ?', ['user_games', table_name]);
        if (count_rows[0].count === 0) {
            // 根据 user_games_info 表创建新表
            let [create_rows] = await games_db_con.query('create table ?? like user_games_info', [table_name]);
        }
        // 更新 steam_account 表 steam_id
        let [update_rows] = await box_db_con.query('update steam_account set steam_id = ? where uid = ? and sid = ?', [steam_id, uid, sid]);
        res.json({
            success: true,
            result: `[初始化成功]steam_id:${steam_id}`
        });
    } catch (err) {
        res.json({
            success: false,
            msg: err.message
        });
    }
    if (mysql_obj) mysql_obj.end(); // 释放mysql连接，重要！！
})

// 获取账号游戏库
router.post('/get_games_list', async (req, res) => {
    let mysql_obj = new mysql();
    let uid = req.user.uid;
    let sid = req.body.sid || (() => {
        throw Error('缺少必填参数')
    })();

    // 分页参数
    let current_page = req.body.current_page || 1;
    let page_size = req.body.page_size || 10;
    // current_page 和 page_size 均为数字
    /^\d+$/.test(current_page) && /^\d+$/.test(page_size) || (() => {
        throw Error('[格式错误]current_page或page_size')
    })();

    // 排序参数
    let filter_key = req.body.filter_key || 'played_time';
    ['played_time', 'game_id', 'game_name'].includes(filter_key) || (() => {
        throw Error('[格式错误]filter_key')
    })();
    let filter_order = req.body.filter_order || 'desc';
    ['desc', 'asc'].includes(filter_order) || (() => {
        throw Error('[格式错误]filter_order')
    })();

    try {
        let box_db_con = await mysql_obj.connect('steam_box');
        const [steam_rows] = await box_db_con.query('select steam_id from steam_account where uid = ? and sid = ?', [uid, sid]);
        if (steam_rows.length === 0) {
            throw Error(`当前配额不存在,请刷新后重试!`)
        }

        let steam_account = steam_rows[0];
        let steam_id = steam_account.steam_id;
        if (!steam_account.steam_id) {
            throw Error(`当前账号还未初始化,请刷新后重试!`)
        }

        // 生成游戏表名称
        let table_id = steam_id.slice(-2);
        let table_name = `user_games_info_${table_id}`;

        let games_db_con = await mysql_obj.connect('user_games');
        // 获取游戏数量
        let [count_rows] = await games_db_con.query('select count(*) as count from ?? where steam_id = ?',
            [table_name, steam_id]
        );
        let total = count_rows[0].count;
        let total_page = Math.floor(total / page_size) + 1;
        if (current_page > total_page) {
            throw Error(`当前页数超过总页数`)
        }

        // 获取游戏列表，属于steam_id
        let [games_rows] = await games_db_con.query(`select game_id, game_name, played_time, selected from ??
                                                     where steam_id = ?
                                                     order by ?? ${filter_order} limit ?, ?`,
            [table_name, steam_id, filter_key, (current_page - 1) * page_size, page_size]
        );

        res.json({
            success: true,
            result: games_rows,
            total: total
        });
    } catch (err) {
        res.json({
            success: false,
            msg: err.message
        });
    }
    if (mysql_obj) mysql_obj.end(); // 释放mysql连接，重要！！
})

// 更换节点
router.post('/change_server', async (req, res) => {
    let mysql_obj = new mysql();
    let uid = req.user.uid;
    let sid = req.body.sid || (() => {
        throw Error('缺少必填参数')
    })();
    let action = req.body.action;
    try {
        let box_db_con = await mysql_obj.connect('steam_box');
        // 查询绑定的服务器
        let [steam_account_res] = await box_db_con.query('select steam_uname,host from steam_account where sid = ? and uid = ?', [sid, uid]);
        if (steam_account_res.length === 0) {
            throw Error(`当前配额不存在,请刷新后重试!`)
        }
        let steam_account = steam_account_res[0];

        let steam_uname = steam_account.steam_uname;
        let host = steam_account.host;
        // 查询服务器信息
        let [server_info] = await box_db_con.query('select hostName from server_info where host = ?', [host]);
        let host_name = server_info[0].hostName;
        let host_id = host_name.split('-')[1];
        let new_host_id = (parseInt(host_id) + 11) % 40 || 40;
        let new_host_name = 'sg-' + new_host_id;

        if (action === 'change') {

            // 查询new_host_name的服务器信息
            let [new_server_info] = await box_db_con.query('select host from server_info where hostName = ?', [new_host_name]);
            let new_host = new_server_info[0].host;

            // 删除bot
            let asf_con = new asf(host);
            await asf_con.delBot(steam_uname);

            // 更新数据库steam_uname为null,并且host为新的服务器
            await box_db_con.query('update steam_account set host = ?, steam_uname = null where sid = ?', [new_host, sid]);

            // 更新user_info表中的base_host
            await box_db_con.query('update user_info set base_host = ? where uid = ?', [new_host, uid]);

            // 更新server_info中的leave_bot_num
            await box_db_con.query('update server_info set leave_bot_num = leave_bot_num + 1 where host = ?', [host]);

            // 插入日志
            await box_db_con.query('insert into steam_record set ?', {
                uid: uid,
                content: `[${steam_uname}] 节点从 ${host_name} 切换到 ${new_host_name}`
            })
        }
        // 服务器组ID为最后两位
        res.json({
            success: true,
            result: {
                current_id: host_name,
                new_id: new_host_name,
            },
            msg: action === 'change' ? '切换成功' : '查询成功'
        });
        if (mysql_obj) mysql_obj.end(); // 释放mysql连接，重要！！
    } catch (e) {
        res.json({
            success: false,
            msg: e.message
        });
    }
})

// 清理 Steam account
router.post('/clear', async (req, res) => {
    let mysql_obj = new mysql();
    let uid = req.user.uid;
    let sid = req.body.sid || (() => {
        throw Error('缺少必填参数')
    })();
    try {
        let box_db_con = await mysql_obj.connect('steam_box');
        const [steam_rows] = await box_db_con.query('select steam_uname,steam_id,duedate,host from steam_account where uid = ? and sid = ?', [uid, sid]);
        let steam_account = steam_rows[0] || (() => {
            throw Error(`当前配额不存在,请刷新后重试!`)
        })();

        // 判断当前账号是否到期，如果未到期，不能清理
        let today = new Date();
        let duedate = new Date(steam_account.duedate);
        if (duedate > today) {
            throw Error(`当前配额未到期,不能清理!`)
        }

        // 如果存在steam_id，则需要先清理游戏库
        if (steam_account.steam_id) {
            let games_db_con = await mysql_obj.connect('user_games');
            let steam_id = steam_account.steam_id;
            let table_id = steam_id.slice(-2);
            let table_name = `user_games_info_${table_id}`;
            await games_db_con.query('delete from ?? where steam_id = ?', [table_name, steam_id]);
        }

        // 如果还有steam_uname，代表bot账号还未清理，需要删除bot
        if (steam_account.steam_uname) {
            // 建立 asf 连接
            let host = steam_account.host;
            let asf_con = new asf(host);
            // 删除 bot
            let del_res = await asf_con.delBot(steam_account.steam_uname);
        }

        // 删除 steam_account
        let [del_rows] = await box_db_con.query('delete from steam_account where sid = ?', sid);

        res.json({
            success: true,
            result: `[sid:${sid}]清理成功!`
        });
    } catch (err) {
        res.json({
            success: false,
            msg: err.message
        });
    }
    if (mysql_obj) mysql_obj.end(); // 释放mysql连接，重要！！
})

module.exports = router;