import React from 'react'

const TEXT_NODE = 'ObojoboDraft.Chunks.Text'

const Node = props => {
  return (
    <p {...props.attributes}>{props.childen}</p>
  )
}

const slateToObo = node => {
  const json = {}
  json.id = node.key
  json.type = node.type
  if (node.data) json.content = node.data.get('content') || {}

  return json
}

const toggleNode = (change, toggleType) => {
  const isType = change.value.blocks.some(block => block.type === toggleType)

  change.setBlocks(isType ? { type: TEXT_NODE, data: { content: { indent: 0 }}} : toggleType)
}

const DefaultNode = {
  components: {
    Node
  },
  helpers: {
    slateToObo,
    toggleNode
  }
}

export default DefaultNode
