UPDATE users
SET
/*%for item in updates separating , */
  /*!item.name*/email = /*$item.value*/'sample'
/*%end */
WHERE id = /*$where.id*/1
RETURNING *
