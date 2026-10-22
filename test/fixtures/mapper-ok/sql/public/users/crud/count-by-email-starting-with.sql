SELECT count(*)::int AS count FROM users
WHERE email LIKE /*$email*/'sample%' ESCAPE '\'
