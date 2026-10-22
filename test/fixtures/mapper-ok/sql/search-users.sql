SELECT id, email
FROM users
WHERE
/*%if q */
  name LIKE /*$q*/'a%' ESCAPE '\'
/*%end*/
ORDER BY id
LIMIT /*$limit*/10
