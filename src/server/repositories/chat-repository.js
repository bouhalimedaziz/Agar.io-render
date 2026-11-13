const db = require("../sql.js");

const logChatMessage = async (username, message, ipAddress, roomId) => {
    const timestamp = new Date().getTime();

    return new Promise((resolve) => {
        db.run(
            "INSERT INTO chat_messages (username, message, ip_address, room_id, timestamp) VALUES (?, ?, ?, ?, ?)",
            [username, message, ipAddress, roomId === undefined ? null : roomId, timestamp],
            (err) => {
                if (err) console.error(err);
                resolve();
            }
        );
    });
};

module.exports = {
    logChatMessage,
};
