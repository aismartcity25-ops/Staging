const { OpenAIEmbeddings } = require('@langchain/openai');
const { InMemoryVectorStore } = require('@langchain/core/vectorstores/memory');
const { Document } = require('@langchain/core/documents');
const fs = require('fs');
const path = require('path');
const { RecursiveCharacterTextSplitter } = require('@langchain/community/text_splitter');

class LocalRAG {
  constructor(openai) {
    this.embeddings = new OpenAIEmbeddings({ openai });
    this.store = null;
    this.openai = openai;
  }

  async initialize(templatesDir = './knowledge-base') {
    const files = fs.readdirSync(templatesDir).filter(f => f.endsWith('.md'));
    const docs = [];
    for (const file of files) {
      const content = fs.readFileSync(path.join(templatesDir, file), 'utf8');
      docs.push(new Document({ pageContent: content, metadata: { source: file } }));
    }
    
    const splitter = new RecursiveCharacterTextSplitter({ chunkSize: 1000, chunkOverlap: 200 });
    const splits = await splitter.splitDocuments(docs);
    
    this.store = await InMemoryVectorStore.fromDocuments(splits, this.embeddings);
    console.log(`Indexed ${splits.length} chunks from ${files.length} templates`);
  }

  async retrieveSimilar(query, k = 5) {
    if (!this.store) throw new Error('RAG not initialized. Call initialize() first.');
    const results = await this.store.similaritySearch(query, k);
    return results.map(doc => doc.pageContent).join('\n\n');
  }
}

module.exports = { LocalRAG };

