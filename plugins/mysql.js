/*
 * @Author: luyu
 * @Date: 2022-04-18 23:12:03
 * @LastEditors: luyu
 * @LastEditTime: 2022-06-19 16:12:24
 * @FilePath: /steam-box-server/plugins/mysql.js
 * @Description: 生成 mysql 连接
 */
const mysql = require("mysql2/promise");
let db_list = ['steam_box', 'steam_data', 'user_games'];
// 对每个db构建连接池
let pool_list = {};
for (let db_name of db_list) {
    pool_list[db_name] = mysql.createPool({
        host: 'rm-.mysql.rds.aliyuncs.com',
        user: 'xxx',
        password: 'xxx',
        connectionLimit: 10,
        database: db_name,
        multipleStatements: true, // 允许多句查询
        connectTimeout: 2000 // 两秒即超时
    });
}

class Mysql {
    
    // 构造自己的数据库连接字典
    constructor() {
        this.db_con = {};
    }

    async connect(db_name) {
        // 连接数据库
        try {
            // 如果数据库连接字典中已经存在连接，则直接返回
            if (this.db_con[db_name]) {
                return this.db_con[db_name];
            }else{
                let con = await pool_list[db_name].getConnection();
                // 并将连接存入连接池
                this.db_con[db_name] = con;
                return con;
            }
        } catch (error) {
            throw Error('数据库连接失败');
        }
    }

    end() {
        // 遍历数据库连接字典，并释放所有连接
        for (let key in this.db_con) {
            this.db_con[key].release();
        }
        return true;
    }

    // 关闭连接池
    end_pool(db_name) {
        for (let key in this.db_con) {
            pool_list[key].end();
        }
    }
}

module.exports = Mysql;