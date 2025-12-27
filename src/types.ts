export interface Artist {
  name: string;
  link?: string;
}

export interface Album {
  name: string;
  release_date?: string;
}

export interface Song {
  link: string;
  artists: Artist[];
  album?: Album;
}
